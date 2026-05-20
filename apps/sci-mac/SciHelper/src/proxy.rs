//! SCI-148 — explicit HTTPS-proxy mode.
//!
//! `sci-helper --proxy <port>` exposes the engine as a standard HTTPS
//! proxy that any tool supporting `https_proxy=http://127.0.0.1:port`
//! can drive. Clients send a `CONNECT api.anthropic.com:443 HTTP/1.1`
//! request line, we reply `HTTP/1.1 200 Connection established`, then
//! the same TCP socket carries the client's TLS ClientHello.
//!
//! From there it's identical to the NetworkExtension path: our
//! `TlsAcceptor` mints a leaf cert via the SNI resolver, the TLS
//! handshake completes, and `flow::dispatch_tls_request` reads the
//! decrypted HTTP request, injects credentials, dispatches to the
//! provider handler, and streams the response back. SCI-138 events
//! flow on the same bus so a Settings panel sees both transports
//! identically.
//!
//! Why this exists:
//!
//!   1. **End-to-end testing without the OS extension.** Lets us
//!      verify SCI-146 (Claude Code system-prompt mimicry) and the
//!      whole engine pipeline against real Anthropic without the
//!      Apple NE entitlement in the loop.
//!   2. **Cross-platform dogfood path.** Linux + Windows have no
//!      NETransparentProxy; the proxy mode is the only capture
//!      surface the engine has on those platforms.
//!   3. **Tool compat.** Anything that honors `https_proxy` (curl,
//!      most SDKs, half the Python ecosystem) can route through Sci
//!      without per-tool config.

use anyhow::{Context, Result, anyhow};
use std::net::SocketAddr;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use sci_core::handlers::is_intercepted_host;

use crate::flow::{SharedState, dispatch_tls_request};

/// Bind a TCP listener on `addr` and accept-loop forever. One task
/// per inbound connection. Errors on individual connections are
/// logged and swallowed; only a fatal listener error propagates.
pub async fn serve_proxy(addr: SocketAddr, state: SharedState) -> Result<()> {
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind proxy listener on {addr}"))?;
    tracing::info!(%addr, "proxy listening (CONNECT-only HTTPS proxy)");
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "proxy accept failed");
                continue;
            }
        };
        let s = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_proxy_connection(stream, s).await {
                // Per-connection errors (bad CONNECT, TLS failure,
                // unsupported method) are normal under adversarial
                // conditions. Log + carry on; never crash the listener.
                tracing::warn!(?peer, error = %e, "proxy connection ended with error");
            }
        });
    }
}

/// Handle one inbound proxy connection.
///
///   1. Read the CONNECT request line + headers.
///   2. Parse `CONNECT host:port HTTP/1.1`.
///   3. Reply `HTTP/1.1 200 Connection established\r\n\r\n`.
///   4. TLS-accept on the same TCP stream — the SNI resolver mints
///      a leaf cert for the requested host.
///   5. Hand off to the shared dispatcher.
async fn handle_proxy_connection(stream: TcpStream, state: SharedState) -> Result<()> {
    // We use BufReader for the request-line read + header drain, but
    // we need the underlying stream back (with whatever bytes are
    // still in BufReader's buffer) to feed into the TLS acceptor. The
    // tokio approach: read just the headers, then let the BufReader
    // drop without buffering more — a CONNECT request has no body, so
    // the next byte after the blank line is the client's TLS
    // ClientHello, which BufReader hasn't touched. To be safe we
    // bound buffered reads to exactly the header section.
    let mut reader = BufReader::new(stream);

    // Request line.
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let req_line = line.trim_end_matches(['\r', '\n']);

    let target = match classify_request_line(req_line) {
        // Operator smoke-test endpoint. `curl http://localhost:3001/healthz`
        // is a reasonable thing for someone diagnosing the service to try;
        // returning the CONNECT-only 405 there is technically correct but
        // unfriendly. Drain headers and reply 200 with a tiny status body.
        RequestDisposition::Healthz => {
            drain_request_headers(&mut reader).await?;
            let mut stream = reader.into_inner();
            let _ = write_healthz_response(&mut stream).await;
            let _ = stream.shutdown().await;
            return Ok(());
        }
        RequestDisposition::Connect(t) => t,
        RequestDisposition::Invalid => {
            // Write a real 405 back to the client so curl/Postman/etc.
            // see an actionable message instead of a closed connection.
            let mut stream = reader.into_inner();
            let _ = write_method_not_allowed_response(&mut stream, req_line).await;
            let _ = stream.shutdown().await;
            return Err(anyhow!("proxy only supports HTTPS via CONNECT; got {req_line:?}"));
        }
    };

    // Drain headers (Host:, Proxy-Authorization:, etc.). We don't
    // currently inspect any of them — auth is handled at the inner
    // request layer by the credential injector. Bound at 64 KiB
    // defense-in-depth.
    let mut header_bytes_seen = 0usize;
    loop {
        let mut hdr = String::new();
        let n = reader.read_line(&mut hdr).await?;
        if n == 0 {
            return Err(anyhow!("client closed before CONNECT headers complete"));
        }
        header_bytes_seen += n;
        if header_bytes_seen > 64 * 1024 {
            return Err(anyhow!("CONNECT headers exceed 64 KiB"));
        }
        if hdr == "\r\n" || hdr == "\n" { break; }
    }

    // Recover the underlying TcpStream. BufReader::into_inner gives
    // us the raw stream; any bytes BufReader pre-read past the header
    // boundary would be lost — but a well-behaved client won't send
    // ClientHello until we ack the CONNECT, so the stream's read side
    // should be empty at this point. Defense-in-depth: if BufReader
    // *did* buffer a leftover, we'd need to splice it onto the front
    // of the TLS read; in practice it doesn't, and we'd see TLS
    // handshake failures if it ever did.
    let mut stream = reader.into_inner();

    // Ack the CONNECT. Anything other than 200 here would tell the
    // client to abort; we use 200 with the canonical phrase that
    // every HTTPS proxy emits.
    stream
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await?;
    stream.flush().await?;

    tracing::debug!(host = %target.hostname, port = target.port, "proxy CONNECT accepted");

    // SCI-150: only MITM hosts we have handlers for. Anything else
    // (downloads.claude.ai for update checks, Datadog telemetry,
    // any non-AI traffic that happens to flow through this proxy)
    // gets a plain CONNECT tunnel — bytes piped between client and
    // destination without inspection. This is privacy-correct (Sci
    // never sees what it doesn't need to) AND functionally required
    // (clients with cert pinning, non-HTTP TLS payloads, or unknown
    // protocols would all break under MITM).
    if is_intercepted_host(&target.hostname) {
        // TLS handshake. Same acceptor the NE path uses; the SNI
        // resolver mints a leaf cert for whatever ClientHello the
        // client sends.
        let tls = state
            .tls_acceptor
            .clone()
            .accept(stream)
            .await
            .context("TLS handshake on proxy CONNECT")?;

        // Hand off to the shared dispatcher. Same engine pipeline as
        // the NE-flow path — anonymize, inject credentials (incl.
        // OAuth + Claude Code prefix), forward, deanonymize.
        dispatch_tls_request(tls, target.hostname, state).await
    } else {
        // Pass-through tunnel: connect to the real destination and
        // pipe bytes both ways. The client's TLS handshake goes
        // straight to the real server; Sci sees only encrypted bytes
        // and forwards them blindly.
        run_connect_tunnel(stream, &target).await
    }
}

/// Plain TCP relay between the client (already past CONNECT ack) and
/// the upstream destination. No TLS termination, no inspection. Returns
/// when either side closes.
async fn run_connect_tunnel(client: TcpStream, target: &ConnectTarget) -> Result<()> {
    let upstream_addr = format!("{}:{}", target.hostname, target.port);
    let upstream = TcpStream::connect(&upstream_addr)
        .await
        .with_context(|| format!("dial upstream {upstream_addr}"))?;

    let (mut client_r, mut client_w) = client.into_split();
    let (mut up_r, mut up_w) = upstream.into_split();

    // Bidirectional copy. tokio::io::copy is unidirectional, so we
    // spawn one task per direction. Either-side EOF closes both.
    let c2u = async move {
        let _ = tokio::io::copy(&mut client_r, &mut up_w).await;
        let _ = up_w.shutdown().await;
    };
    let u2c = async move {
        let _ = tokio::io::copy(&mut up_r, &mut client_w).await;
        let _ = client_w.shutdown().await;
    };
    tokio::join!(c2u, u2c);
    Ok(())
}

/// Read header lines from `reader` until a blank line, discarding
/// content. Bound at 64 KiB so a buggy or hostile client can't make us
/// buffer unbounded data on a `/healthz` smoke test. Generic over the
/// inner reader so tests can drive it with `tokio::io::duplex` instead
/// of a real `TcpStream`.
async fn drain_request_headers<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<()> {
    let mut header_bytes_seen = 0usize;
    loop {
        let mut hdr = String::new();
        let n = reader.read_line(&mut hdr).await?;
        if n == 0 {
            return Err(anyhow!("client closed before request headers complete"));
        }
        header_bytes_seen += n;
        if header_bytes_seen > 64 * 1024 {
            return Err(anyhow!("request headers exceed 64 KiB"));
        }
        if hdr == "\r\n" || hdr == "\n" { break; }
    }
    Ok(())
}

/// Outcome of parsing the first HTTP request line off a proxy
/// connection. `handle_proxy_connection` dispatches on this; tests
/// exercise the pure-string branch logic without sockets.
#[derive(Debug, PartialEq)]
enum RequestDisposition {
    /// `GET /healthz …` or `GET /_status …` — operator smoke test.
    Healthz,
    /// Valid `CONNECT host:port HTTP/1.1`.
    Connect(ConnectTarget),
    /// Anything else — caller writes a 405 and closes.
    Invalid,
}

fn classify_request_line(req_line: &str) -> RequestDisposition {
    if req_line.starts_with("GET /healthz ") || req_line.starts_with("GET /_status ") {
        RequestDisposition::Healthz
    } else if let Ok(target) = parse_connect_target(req_line) {
        RequestDisposition::Connect(target)
    } else {
        RequestDisposition::Invalid
    }
}

/// Write a 200 OK JSON status body. Generic over the writer so tests
/// can capture into a `Vec<u8>`.
async fn write_healthz_response<W: AsyncWrite + Unpin>(w: &mut W) -> std::io::Result<()> {
    let body = format!(
        "{{\"status\":\"ok\",\"version\":\"{}\"}}\n",
        env!("CARGO_PKG_VERSION"),
    );
    let resp = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len(),
    );
    w.write_all(resp.as_bytes()).await
}

/// Write a 405 Method Not Allowed response explaining that the proxy
/// only supports HTTPS CONNECT, plus hints for the two most common
/// misconfigurations (`HTTP_PROXY` vs `HTTPS_PROXY`, and
/// `ANTHROPIC_BASE_URL`).
async fn write_method_not_allowed_response<W: AsyncWrite + Unpin>(
    w: &mut W,
    req_line: &str,
) -> std::io::Result<()> {
    let body = format!(
        "Sci proxy supports HTTPS via CONNECT only.\n\
         Got: {req_line}\n\
         If you set HTTP_PROXY=… instead of HTTPS_PROXY=…, swap them.\n\
         If you set ANTHROPIC_BASE_URL=http://…:3001 (treating Sci\n\
         as the API endpoint), unset it and use HTTPS_PROXY instead.\n",
    );
    let resp = format!(
        "HTTP/1.1 405 Method Not Allowed\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len(),
    );
    w.write_all(resp.as_bytes()).await
}

#[derive(Debug, PartialEq)]
struct ConnectTarget {
    hostname: String,
    port:     u16,
}

/// Parse `CONNECT host:port HTTP/1.1` into a hostname + port. Rejects
/// any other method — a proxy that forwarded plain HTTP would be
/// a credential-leak vector (the client would have stamped its API
/// key on the wire in plaintext to a non-AI host).
fn parse_connect_target(req_line: &str) -> Result<ConnectTarget> {
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let _version = parts.next().unwrap_or("");

    if method != "CONNECT" {
        return Err(anyhow!(
            "proxy only supports HTTPS via CONNECT; got method {method:?}"
        ));
    }
    let (host, port_str) = target
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("CONNECT target missing :port: {target:?}"))?;
    let port: u16 = port_str
        .parse()
        .map_err(|e| anyhow!("CONNECT port {port_str:?} not parseable: {e}"))?;

    Ok(ConnectTarget {
        hostname: host.to_string(),
        port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_connect_line() {
        let t = parse_connect_target("CONNECT api.anthropic.com:443 HTTP/1.1").unwrap();
        assert_eq!(t, ConnectTarget {
            hostname: "api.anthropic.com".into(),
            port: 443,
        });
    }

    #[test]
    fn rejects_non_connect_method() {
        let err = parse_connect_target("GET / HTTP/1.1").unwrap_err();
        assert!(format!("{err}").contains("CONNECT"));
    }

    #[test]
    fn rejects_target_without_port() {
        let err = parse_connect_target("CONNECT api.anthropic.com HTTP/1.1").unwrap_err();
        assert!(format!("{err}").contains("missing :port"));
    }

    #[test]
    fn rejects_unparseable_port() {
        let err = parse_connect_target("CONNECT host:abc HTTP/1.1").unwrap_err();
        assert!(format!("{err}").contains("not parseable"));
    }

    #[test]
    fn parses_ipv6_literal_target() {
        // `rsplit_once(':')` splits at the *last* colon, which leaves
        // the bracketed IPv6 address intact as the hostname.
        let t = parse_connect_target("CONNECT [::1]:443 HTTP/1.1").unwrap();
        assert_eq!(t.hostname, "[::1]");
        assert_eq!(t.port, 443);
    }

    // ── classify_request_line ─────────────────────────────────────────

    #[test]
    fn classify_recognizes_healthz() {
        assert_eq!(
            classify_request_line("GET /healthz HTTP/1.1"),
            RequestDisposition::Healthz
        );
        assert_eq!(
            classify_request_line("GET /_status HTTP/1.1"),
            RequestDisposition::Healthz
        );
    }

    #[test]
    fn classify_recognizes_connect() {
        match classify_request_line("CONNECT api.anthropic.com:443 HTTP/1.1") {
            RequestDisposition::Connect(t) => {
                assert_eq!(t.hostname, "api.anthropic.com");
                assert_eq!(t.port, 443);
            }
            other => panic!("expected Connect, got {other:?}"),
        }
    }

    #[test]
    fn classify_rejects_post_to_healthz() {
        // Only GET on /healthz is the smoke-test endpoint. POST falls
        // through to parse_connect_target and is reported as Invalid.
        assert_eq!(
            classify_request_line("POST /healthz HTTP/1.1"),
            RequestDisposition::Invalid
        );
    }

    #[test]
    fn classify_rejects_healthz_without_trailing_space() {
        // The trailing-space match means `/healthzyz` is not Healthz.
        assert_eq!(
            classify_request_line("GET /healthzyz HTTP/1.1"),
            RequestDisposition::Invalid
        );
    }

    #[test]
    fn classify_rejects_plain_get_root() {
        assert_eq!(
            classify_request_line("GET / HTTP/1.1"),
            RequestDisposition::Invalid
        );
    }

    #[test]
    fn classify_rejects_head() {
        assert_eq!(
            classify_request_line("HEAD /healthz HTTP/1.1"),
            RequestDisposition::Invalid
        );
    }

    // ── write_healthz_response ────────────────────────────────────────

    #[tokio::test]
    async fn healthz_response_is_200_json_with_version() {
        let mut buf: Vec<u8> = Vec::new();
        write_healthz_response(&mut buf).await.unwrap();
        let resp = std::str::from_utf8(&buf).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200 OK\r\n"), "got: {resp}");
        assert!(resp.contains("Content-Type: application/json\r\n"));
        assert!(resp.contains("Connection: close\r\n"));
        assert!(resp.contains("\"status\":\"ok\""));
        assert!(
            resp.contains(env!("CARGO_PKG_VERSION")),
            "response body should include crate version"
        );
        let content_length_line = resp
            .lines()
            .find(|l| l.starts_with("Content-Length:"))
            .expect("Content-Length present");
        let stated_len: usize = content_length_line["Content-Length:".len()..]
            .trim()
            .parse()
            .unwrap();
        let body = resp.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(body.len(), stated_len, "Content-Length matches body bytes");
    }

    // ── write_method_not_allowed_response ─────────────────────────────

    #[tokio::test]
    async fn method_not_allowed_response_uses_sci_proxy_branding() {
        let mut buf: Vec<u8> = Vec::new();
        write_method_not_allowed_response(&mut buf, "GET / HTTP/1.1")
            .await
            .unwrap();
        let resp = std::str::from_utf8(&buf).unwrap();
        assert!(resp.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"));
        assert!(
            resp.contains("Sci proxy supports HTTPS via CONNECT only."),
            "regression guard for SCI postmortem rename: must say \"Sci proxy\", not \"Sci dev-proxy\". Got: {resp}"
        );
        assert!(!resp.contains("dev-proxy"), "no \"dev-proxy\" anywhere in user-facing output");
        assert!(resp.contains("Got: GET / HTTP/1.1"));
        assert!(resp.contains("HTTP_PROXY"));
        assert!(resp.contains("ANTHROPIC_BASE_URL"));
    }

    // ── drain_request_headers ─────────────────────────────────────────

    #[tokio::test]
    async fn drain_consumes_crlf_terminated_headers() {
        let (mut client, server) = tokio::io::duplex(4096);
        // Producer side writes a valid request-block tail (Host header
        // + blank line) then closes its write half.
        let producer = tokio::spawn(async move {
            tokio::io::AsyncWriteExt::write_all(&mut client, b"Host: example.com\r\nUser-Agent: t\r\n\r\n")
                .await
                .unwrap();
            tokio::io::AsyncWriteExt::shutdown(&mut client).await.unwrap();
        });
        let mut reader = BufReader::new(server);
        drain_request_headers(&mut reader).await.unwrap();
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn drain_consumes_lf_only_headers() {
        let (mut client, server) = tokio::io::duplex(4096);
        let producer = tokio::spawn(async move {
            tokio::io::AsyncWriteExt::write_all(&mut client, b"Host: example.com\n\n")
                .await
                .unwrap();
            tokio::io::AsyncWriteExt::shutdown(&mut client).await.unwrap();
        });
        let mut reader = BufReader::new(server);
        drain_request_headers(&mut reader).await.unwrap();
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn drain_errors_when_client_closes_before_blank_line() {
        let (mut client, server) = tokio::io::duplex(4096);
        let producer = tokio::spawn(async move {
            tokio::io::AsyncWriteExt::write_all(&mut client, b"Host: example.com\r\n")
                .await
                .unwrap();
            // Close without writing the terminating blank line.
            tokio::io::AsyncWriteExt::shutdown(&mut client).await.unwrap();
        });
        let mut reader = BufReader::new(server);
        let err = drain_request_headers(&mut reader).await.unwrap_err();
        assert!(format!("{err}").contains("client closed"));
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn drain_errors_on_oversize_headers() {
        // Produce > 64 KiB of header data with no terminating blank
        // line. The duplex buffer is small, so we drive both sides
        // concurrently to avoid the producer wedging on backpressure.
        let (mut client, server) = tokio::io::duplex(8192);
        let producer = tokio::spawn(async move {
            // Each line is 1 KiB. 70 of them gets us safely over the
            // 64 KiB ceiling.
            let line = format!("X-Pad: {}\r\n", "a".repeat(1015));
            assert_eq!(line.len(), 1024);
            for _ in 0..70 {
                if tokio::io::AsyncWriteExt::write_all(&mut client, line.as_bytes())
                    .await
                    .is_err()
                {
                    // Reader rejected and dropped — fine.
                    break;
                }
            }
        });
        let mut reader = BufReader::new(server);
        let err = drain_request_headers(&mut reader).await.unwrap_err();
        assert!(format!("{err}").contains("exceed 64 KiB"));
        let _ = producer.await;
    }
}
