//! Per-flow handler — the SCI-134 protocol the NE talks to us on.
//!
//! Wire shape (per Unix-socket connection):
//!
//!   1. NE writes one JSON line: `{"kind":"flow","hostname":"…","port":443,"sni":"…"}\n`
//!   2. NE then bidirectionally pipes raw bytes between the actual
//!      client TCP flow and this socket — no further framing.
//!
//! Helper side:
//!
//!   1. Read the JSON header.
//!   2. Wrap the remaining stream in `tokio_rustls::TlsAcceptor` using
//!      the per-host leaf cert minted by `sci-tls::CertResolver`. The
//!      handshake reads the client's ClientHello (which the NE forwarded
//!      from the real client), responds with our cert.
//!   3. Read the decrypted HTTP/1.1 request off the TLS stream — request
//!      line + headers via `httparse`, body up to Content-Length.
//!   4. Build a `sci_handlers::HandlerRequest`, dispatch via
//!      `pick_handler`. For non-AI hosts (shouldn't happen given the
//!      OS rule set, but defense-in-depth) we close the flow with a
//!      502.
//!   5. Stream the `HandlerResponse` body back through the TLS-
//!      encrypted side. We send `Connection: close` and don't re-add
//!      Transfer-Encoding: chunked — the client reads bytes until EOF.
//!
//! All of this is per-flow — long-lived state (CA, storage, embedder,
//! upstream client) is owned by `SharedState` and shared across flows
//! via `Arc`.

use anyhow::{Context, Result, anyhow};
use arc_swap::ArcSwap;
use bytes::{BufMut, BytesMut};
use futures::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio_rustls::TlsAcceptor;

use sci_core::handlers::{
    HandlerError, HandlerRequest, HandlerResponse, HandlerState, pick_handler,
};
use sci_core::handlers::upstream::UpstreamRequest;

use crate::credentials::{Credentials, load_credentials, inject_credential_for_host};
use crate::events::{Event, EventBus, now_ts, run_subscriber};

/// JSON header the caller writes once per connection, before any
/// further bytes. Four kinds today:
///
///   - `"flow"` — NetworkExtension handing off a TCP flow. Carries
///     hostname/port/sni; helper terminates TLS + dispatches.
///   - `"events"` — App subscribing to the helper→app event stream.
///     No further fields; helper streams JSON-line events.
///   - `"reload_credentials"` — App re-saved `~/.sci/credentials.env`
///     and is asking the helper to swap the live credential set.
///     Helper acks with a one-line JSON `{"ok":true,"providers":[…]}`
///     and emits a `credentials_reloaded` event on the bus so any
///     other subscribers see the change.
///   - PING/PONG — single-line text, not JSON; handled separately.
///
/// `kind` is mandatory; missing or unknown values produce a hard error
/// rather than be interpreted as flow bytes.
#[derive(Debug, Deserialize)]
struct ConnectionHeader {
    kind:     String,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    port:     u16,
    #[serde(default)]
    sni:      String,
}

/// Concrete flow header derived from a `ConnectionHeader { kind: "flow" }`.
#[derive(Debug)]
pub struct FlowHeader {
    pub hostname: String,
    pub port:     u16,
    pub sni:      String,
}

/// State pinned for the lifetime of the helper. One per process.
/// Cheap to clone (just clones the `Arc`s + the broadcast Sender's
/// internal Arc).
#[derive(Clone)]
pub struct SharedState {
    pub tls_acceptor:  TlsAcceptor,
    pub handler_state: Arc<HandlerState>,
    /// SCI-138: emit-only side of the helper→app event channel. Each
    /// flow handler emits FlowStarted at entry and FlowCompleted /
    /// FlowError at exit. App subscribers consume via
    /// `run_subscriber` after sending a `{"kind":"events"}` header.
    pub events:        EventBus,
    /// SCI-128: BYO credentials, loaded at startup from env +
    /// `~/.sci/credentials.env`. SCI-141 made this hot-reloadable: the
    /// app's reload IPC re-reads the file and `store()`s a new
    /// snapshot here. Per-flow `inject_credential_for_host` calls
    /// `load()` (single atomic) on the hot path — lock-free, no
    /// contention with the reload writer.
    pub credentials:   Arc<ArcSwap<Credentials>>,

    /// Config dir, captured at startup. The reload IPC re-reads
    /// `<config_dir>/credentials.env` from here. Held alongside the
    /// `credentials` swap rather than recomputed from `HOME` so a
    /// reload after `cd $TMPDIR` (tests, dev shells with overridden
    /// `SCI_CONFIG_DIR`) still hits the right file.
    pub config_dir:    Arc<PathBuf>,
}

/// Top-level per-connection entry point. Reads the first line:
///
///   - "PING" → reply "PONG\n" (Settings panel's helper-status check)
///   - "{...flow header...}" → run the flow protocol
///   - anything else → log + close
///
/// Keeping PING here means the Settings UI doesn't need a separate
/// control socket. One channel, one mental model.
pub async fn handle_session(stream: UnixStream, state: SharedState) -> Result<()> {
    let mut stream = stream;
    let first_line = read_line(&mut stream).await
        .context("read first line from NE / control client")?;

    if first_line.trim() == "PING" {
        stream.write_all(b"PONG\n").await?;
        return Ok(());
    }

    let header: ConnectionHeader = serde_json::from_str(&first_line)
        .with_context(|| format!("parse connection header: {first_line:?}"))?;

    match header.kind.as_str() {
        "flow" => {
            let flow = FlowHeader {
                hostname: header.hostname,
                port:     header.port,
                sni:      header.sni,
            };
            handle_flow(stream, flow, state).await
        }
        "events" => {
            // SCI-138: drain side of the event bus. Each subscriber
            // gets its own broadcast::Receiver — fan-out is automatic.
            run_subscriber(stream, &state.events).await
        }
        "reload_credentials" => {
            // SCI-141: re-read `~/.sci/credentials.env` and swap the
            // live credential set. App calls this after the user saves
            // a key in Settings → Credentials.
            handle_reload_credentials(
                stream,
                &state.config_dir,
                &state.credentials,
                &state.events,
            ).await
        }
        other => Err(anyhow!("unsupported header kind: {other:?}")),
    }
}

/// SCI-141 reload: re-read the credentials file, swap into the
/// `ArcSwap`, ack the caller, and emit a `credentials_reloaded` event
/// for any open subscribers (so multiple Settings windows / the menu
/// bar all see the change).
///
/// We deliberately don't return an error if the file is missing —
/// "no credentials" is a valid state (the user wiped them all). The
/// ack lists the providers that *are* configured after the reload.
async fn handle_reload_credentials(
    stream:      UnixStream,
    config_dir:  &std::path::Path,
    creds_swap:  &ArcSwap<Credentials>,
    events:      &EventBus,
) -> Result<()> {
    let new = load_credentials(config_dir);
    let providers: Vec<String> = new
        .provider_names()
        .into_iter()
        .map(String::from)
        .collect();
    creds_swap.store(Arc::new(new));
    tracing::info!(
        providers = ?providers,
        "credentials reloaded via IPC",
    );
    events.emit(Event::CredentialsReloaded {
        providers: providers.clone(),
        ts:        now_ts(),
    });

    // Ack: one JSON line, then close. Mirrors the PING/PONG shape so
    // the Swift caller can read-line + parse without a framing decoder.
    let ack = serde_json::json!({
        "ok":        true,
        "providers": providers,
    });
    let line = serde_json::to_string(&ack)?;
    let mut stream = stream;
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await.ok();
    Ok(())
}

/// Run the TLS-MITM + dispatch pipeline against the bytes that follow
/// the JSON header on the same Unix socket.
async fn handle_flow(stream: UnixStream, header: FlowHeader, state: SharedState) -> Result<()> {
    tracing::info!(
        host = %header.hostname,
        port = header.port,
        sni  = %header.sni,
        "flow inbound",
    );
    let tls_acceptor = state.tls_acceptor.clone();
    let tls = match tls_acceptor.accept(stream).await {
        Ok(t) => t,
        Err(e) => {
            state.events.emit(Event::FlowError {
                host:  header.hostname.clone(),
                error: format!("tls handshake: {e}"),
                ts:    now_ts(),
            });
            return Err(e).context("TLS handshake on flow");
        }
    };
    dispatch_tls_request(tls, header.hostname, state).await
}

/// Post-TLS-accept dispatch. Shared between the NE-flow path
/// (`handle_flow`) and the SCI-148 proxy path (`proxy::handle_proxy_connection`).
/// Both transports do the same thing once the TLS handshake is up:
/// parse one HTTP request, inject Sci-side credentials, run the
/// provider handler, stream the response back. This function emits
/// the `FlowStarted` / `FlowCompleted` / `FlowError` events on the
/// shared bus so the UI doesn't have to care which transport the
/// flow came in on.
pub(crate) async fn dispatch_tls_request<S>(
    tls:      tokio_rustls::server::TlsStream<S>,
    hostname: String,
    state:    SharedState,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    state.events.emit(Event::FlowStarted {
        host: hostname.clone(),
        ts:   now_ts(),
    });
    let started_at = std::time::Instant::now();

    let host_for_events = hostname.clone();
    let bus = state.events.clone();
    let emit_error = |error: String| {
        bus.emit(Event::FlowError {
            host: host_for_events.clone(),
            error,
            ts:   now_ts(),
        });
    };

    let (mut read_half, mut write_half) = tokio::io::split(tls);

    // Read HTTP request from the decrypted stream.
    let parsed = match read_http_request(&mut read_half).await {
        Ok(p) => p,
        Err(e) => {
            emit_error(format!("http parse: {e}"));
            return Err(e).context("parse HTTP request");
        }
    };

    // Inject Sci-side credentials, then dispatch.
    //
    // SCI-128: this is the layer that makes "set up Sci once, every
    // tool just works" actually true. Before injecting, the helper
    // forwarded whatever credential the calling tool sent (and 401
    // if the tool sent none). After injecting, the user's configured
    // key is what upstream sees, regardless of what the tool's HTTP
    // stack put on the wire. Pass-through is preserved for tools that
    // bring their own keys: if the user hasn't configured Sci with a
    // credential for this provider, we leave the tool's headers alone.
    let mut headers = parsed.headers;
    // Snapshot the current credentials for this flow. `load()` is a
    // single atomic read on the ArcSwap; we hold the snapshot for the
    // whole flow so a mid-flow reload can't half-swap a header.
    let creds_snapshot = state.credentials.load();
    inject_credential_for_host(&hostname, &mut headers, &creds_snapshot);

    let req = HandlerRequest {
        method:   parsed.method,
        url:      parsed.url,
        headers,
        body:     parsed.body.into(),
        hostname: hostname.clone(),
    };
    // SCI-150: when the host is in the MITM allowlist (we got here)
    // but we don't have a handler for the specific path, forward the
    // request to upstream verbatim. Necessary for tools like Claude
    // Code that hit auxiliary endpoints on api.anthropic.com (e.g.
    // /v1/mcp_servers, /api/event_logging/v2/batch) — without this
    // pass-through Sci would 502 those calls and the tool would wedge.
    //
    // No anonymization, no deanonymization, no SCI-146 prefix
    // injection: those are inference-path concerns. We just relay the
    // bytes the client sent (already with credentials injected per
    // `inject_credential_for_host` above) and stream the response back.
    let mut resp = if let Some(handler) = pick_handler(&req) {
        match handler(req, state.handler_state.clone()).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "handler error");
                emit_error(format!("handler: {e}"));
                return write_error_response(&mut write_half, 502, &e).await;
            }
        }
    } else {
        tracing::debug!(
            host = %hostname,
            method = %req.method,
            path = req.path(),
            "no path handler — forwarding verbatim",
        );
        match forward_passthrough(req, &state.handler_state).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "passthrough forward error");
                emit_error(format!("passthrough: {e}"));
                let he = HandlerError::Upstream(e.to_string());
                return write_error_response(&mut write_half, 502, &he).await;
            }
        }
    };

    // SCI-138 inspector events: emit the post-anonymize request body
    // and (when buffered by the handler) the pre-deanon upstream
    // response body. Always-safe: handlers only populate these with
    // already-masked content. Subscribers are opt-in (sci-tail
    // --bodies; the Settings → Status pane filters by event type).
    if let Some(req_body) = resp.inspect_request.take() {
        let body_str = String::from_utf8_lossy(&req_body).into_owned();
        state.events.emit(Event::FlowAnonymizedRequest {
            host: hostname.clone(),
            body: body_str,
            ts:   now_ts(),
        });
    }
    if let Some(raw_resp) = resp.inspect_upstream_raw.take() {
        let body_str = String::from_utf8_lossy(&raw_resp).into_owned();
        state.events.emit(Event::FlowUpstreamRawResponse {
            host: hostname.clone(),
            body: body_str,
            ts:   now_ts(),
        });
    }

    // SCI-138: peel off the internal `x-sci-masked` header before
    // forwarding to the client.
    let masked: u32 = resp
        .headers
        .remove("x-sci-masked")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let status = resp.status;

    let result = write_response(&mut write_half, resp).await;

    let ms = started_at.elapsed().as_millis().min(u32::MAX as u128) as u32;
    if let Err(ref e) = result {
        tracing::warn!(
            host = %host_for_events,
            error = %e,
            ms,
            "✗ flow ended with write error",
        );
        state.events.emit(Event::FlowError {
            host:  host_for_events,
            error: format!("write_response: {e}"),
            ts:    now_ts(),
        });
    } else {
        // Human-readable single-line summary on stderr. Same data as
        // the `flow_completed` event; this is for users running the
        // helper from a terminal who don't have `sci-tail` open.
        tracing::info!(
            "{} {host:<32} {status} masked={masked} {ms}ms",
            if (200..300).contains(&status) { "✓" } else { "✗" },
            host = host_for_events,
        );
        state.events.emit(Event::FlowCompleted {
            host: host_for_events,
            masked,
            ms,
            status,
            ts: now_ts(),
        });
    }
    result
}

/// SCI-150 path-level pass-through: forward a request to upstream
/// verbatim and return the response unchanged. Used when the host is
/// in the MITM allowlist but no path-level handler matched (e.g.
/// Claude Code hitting `/v1/mcp_servers` on api.anthropic.com — the
/// host IS one we MITM, but it's not the inference endpoint we
/// anonymize).
///
/// We reuse the same `UpstreamClient` the inference handlers use so
/// connection pooling, TLS config, and HTTP/2 negotiation are
/// identical to the rest of the engine.
async fn forward_passthrough(
    req:   HandlerRequest,
    state: &Arc<HandlerState>,
) -> Result<HandlerResponse> {
    let upstream_url = format!("https://{}{}", req.hostname, req.url);
    let upstream_resp = state
        .upstream
        .send(UpstreamRequest {
            method:  req.method,
            url:     upstream_url,
            headers: req.headers,
            body:    req.body,
        })
        .await
        .with_context(|| format!("upstream send to {}", req.hostname))?;
    Ok(HandlerResponse::streaming(
        upstream_resp.status,
        upstream_resp.headers,
        upstream_resp.body,
    ))
}

// ── HTTP request parsing ───────────────────────────────────────────────────

struct ParsedRequest {
    method:  String,
    url:     String,
    headers: HashMap<String, String>,
    body:    Vec<u8>,
}

/// Read until we've seen the headers terminator (`\r\n\r\n`), parse with
/// `httparse`, then read the body up to `Content-Length`. We don't
/// support chunked request bodies in v0.5 — the AI providers' SDKs all
/// send Content-Length, and chunked uploads aren't a Sci-relevant flow.
async fn read_http_request<R>(read_half: &mut R) -> Result<ParsedRequest>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = BytesMut::with_capacity(8 * 1024);

    // Read until headers terminator. Bound the header section at 64 KiB
    // so a malicious client can't OOM us by sending an unbounded
    // request line.
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let n = read_half.read(&mut chunk).await?;
        if n == 0 {
            return Err(anyhow!("client closed before headers complete"));
        }
        buf.put_slice(&chunk[..n]);
        if let Some(idx) = find_subsequence(&buf, b"\r\n\r\n") {
            header_end = idx + 4;
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(anyhow!("request headers exceed 64 KiB"));
        }
    }

    let mut header_storage = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut header_storage);
    let parse_status = req
        .parse(&buf[..header_end])
        .map_err(|e| anyhow!("httparse: {e}"))?;
    if !parse_status.is_complete() {
        return Err(anyhow!("httparse: incomplete after CRLFCRLF"));
    }

    let method = req
        .method
        .ok_or_else(|| anyhow!("missing method"))?
        .to_string();
    let url = req
        .path
        .ok_or_else(|| anyhow!("missing path"))?
        .to_string();

    let mut headers: HashMap<String, String> = HashMap::with_capacity(req.headers.len());
    let mut content_length = 0usize;
    for h in req.headers.iter() {
        let name = h.name.to_ascii_lowercase();
        let value = std::str::from_utf8(h.value)
            .map_err(|e| anyhow!("header {name} not UTF-8: {e}"))?
            .to_string();
        if name == "content-length" {
            content_length = value.trim().parse().unwrap_or(0);
        }
        headers.insert(name, value);
    }

    // Body: anything past header_end in `buf` is already-read body
    // bytes; read more until we have content_length. AI request bodies
    // are JSON ≪1 MiB; cap at 16 MiB defense-in-depth.
    if content_length > 16 * 1024 * 1024 {
        return Err(anyhow!("Content-Length {content_length} exceeds 16 MiB cap"));
    }
    let mut body = Vec::with_capacity(content_length);
    body.extend_from_slice(&buf[header_end..]);
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        let n = read_half.read(&mut chunk).await?;
        if n == 0 { break; }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length); // in case the read picked up extras

    Ok(ParsedRequest { method, url, headers, body })
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── HTTP response writing ──────────────────────────────────────────────────

async fn write_response<W>(
    write_half: &mut W,
    resp: sci_core::handlers::HandlerResponse,
) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    // Status line. We don't have a reason phrase from the
    // HandlerResponse — most clients ignore it; pin "OK" / "X" so the
    // line parses cleanly.
    let status_line = format!("HTTP/1.1 {} OK\r\n", resp.status);
    write_half.write_all(status_line.as_bytes()).await?;

    // Headers. We force `Connection: close` because we don't reuse
    // connections in v0.5 — once we close, the client knows the body
    // ended, no need for chunked framing or Content-Length tracking.
    // Drop any upstream Transfer-Encoding / Content-Length / Connection
    // header to avoid double-framing.
    let mut headers = resp.headers;
    headers.remove("transfer-encoding");
    headers.remove("content-length");
    headers.remove("connection");
    headers.insert("connection".into(), "close".into());

    for (k, v) in &headers {
        let line = format!("{k}: {v}\r\n");
        write_half.write_all(line.as_bytes()).await?;
    }
    write_half.write_all(b"\r\n").await?;

    // Stream body chunks through.
    let mut body = resp.body;
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        if chunk.is_empty() { continue; }
        write_half.write_all(&chunk).await?;
        write_half.flush().await?;
    }
    write_half.shutdown().await.ok();
    Ok(())
}

async fn write_error_response<W>(
    write_half: &mut W,
    status: u16,
    err:    &HandlerError,
) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let body = format!(
        r#"{{"type":"error","error":{{"type":"sci_proxy_error","message":{:?}}}}}"#,
        err.to_string(),
    );
    let bytes = body.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} Error\r\n\
         content-type: application/json\r\n\
         content-length: {}\r\n\
         connection: close\r\n\r\n",
        bytes.len(),
    );
    write_half.write_all(head.as_bytes()).await?;
    write_half.write_all(bytes).await?;
    write_half.shutdown().await.ok();
    Ok(())
}

// ── Misc ───────────────────────────────────────────────────────────────────

async fn read_line(stream: &mut UnixStream) -> Result<String> {
    // Read one byte at a time until '\n'. Lines are short (header is
    // ~100 chars). Cap at 4 KiB defense-in-depth.
    let mut out = Vec::with_capacity(128);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(anyhow!("EOF before newline"));
        }
        if byte[0] == b'\n' { break; }
        out.push(byte[0]);
        if out.len() > 4096 {
            return Err(anyhow!("first line exceeds 4 KiB"));
        }
    }
    Ok(String::from_utf8(out)?)
}

#[cfg(test)]
mod tests {
    //! SCI-141: hot-reload IPC tests. We exercise `handle_reload_credentials`
    //! directly over a `UnixStream::pair()` so we don't have to stand up
    //! the whole `SharedState` (TLS acceptor + handler state + storage).
    //! What we verify:
    //!
    //!   1. Writing a fresh `credentials.env`, calling reload → the
    //!      `ArcSwap` holds the new values; subsequent flow reads see
    //!      them.
    //!   2. The ack JSON lists exactly the providers configured in the
    //!      reloaded file.
    //!   3. A `credentials_reloaded` event is emitted on the bus, with
    //!      the same provider list.
    //!   4. Reload after wiping the file empties the credential set
    //!      cleanly (the "user signed out of every provider" path).
    use super::*;
    use crate::credentials::Credentials;

    /// Set up a tempdir with the given `credentials.env` contents and
    /// an `ArcSwap` seeded to `Credentials::default()`. Returns the
    /// dir handle (drop = cleanup), the swap, and a fresh event bus.
    fn fixture(file: Option<&str>) -> (
        tempfile::TempDir,
        Arc<ArcSwap<Credentials>>,
        EventBus,
    ) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(text) = file {
            std::fs::write(dir.path().join("credentials.env"), text).unwrap();
        }
        let swap = Arc::new(ArcSwap::from(Arc::new(Credentials::default())));
        let bus  = EventBus::new();
        (dir, swap, bus)
    }

    /// Drive `handle_reload_credentials` over a paired UnixStream;
    /// return the ack JSON the helper-side wrote.
    async fn drive_reload(
        config_dir: &std::path::Path,
        creds:      &Arc<ArcSwap<Credentials>>,
        events:     &EventBus,
    ) -> serde_json::Value {
        let (helper_side, mut app_side) = UnixStream::pair().unwrap();
        let cd = config_dir.to_path_buf();
        let cs = creds.clone();
        let bs = events.clone();
        let server = tokio::spawn(async move {
            handle_reload_credentials(helper_side, &cd, &cs, &bs).await
        });
        // Read the ack line from the app side.
        let ack_line = read_line(&mut app_side).await.unwrap();
        server.await.unwrap().unwrap();
        serde_json::from_str(&ack_line).unwrap()
    }

    #[tokio::test]
    async fn reload_swaps_in_new_credentials() {
        let (dir, swap, bus) = fixture(Some(
            "ANTHROPIC_API_KEY=sk-ant-new\nOPENAI_API_KEY=sk-openai-new\n",
        ));
        let mut sub = bus.subscribe();

        let ack = drive_reload(dir.path(), &swap, &bus).await;
        assert_eq!(ack["ok"], serde_json::json!(true));
        let providers = ack["providers"].as_array().unwrap();
        let names: Vec<&str> = providers.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(names.contains(&"anthropic"), "got {names:?}");
        assert!(names.contains(&"openai"),    "got {names:?}");

        // Hot-path readers see the new keys.
        let live = swap.load();
        assert_eq!(live.anthropic.as_deref(), Some("sk-ant-new"));
        assert_eq!(live.openai.as_deref(),    Some("sk-openai-new"));

        // Event was emitted.
        let evt = sub.try_recv().expect("CredentialsReloaded should be on the bus");
        match evt {
            Event::CredentialsReloaded { providers, .. } => {
                assert!(providers.contains(&"anthropic".to_string()));
                assert!(providers.contains(&"openai".to_string()));
            }
            other => panic!("expected CredentialsReloaded, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reload_with_empty_file_clears_credentials() {
        // Seed the swap with anthropic/openai, then point at an empty
        // file. After reload, no providers should be configured.
        let (dir, swap, bus) = fixture(Some(""));
        swap.store(Arc::new(Credentials {
            anthropic: Some("sk-old".into()),
            openai:    Some("sk-old-openai".into()),
            ..Default::default()
        }));

        let ack = drive_reload(dir.path(), &swap, &bus).await;
        assert_eq!(ack["ok"], serde_json::json!(true));
        let providers = ack["providers"].as_array().unwrap();
        assert!(providers.is_empty(), "expected no providers, got {providers:?}");

        let live = swap.load();
        assert!(live.anthropic.is_none());
        assert!(live.openai.is_none());
    }

    #[tokio::test]
    async fn reload_with_missing_file_succeeds_with_no_providers() {
        // Whole point: if the user wipes credentials.env between
        // launches and saves nothing, reload still succeeds.
        let (dir, swap, bus) = fixture(None);

        let ack = drive_reload(dir.path(), &swap, &bus).await;
        assert_eq!(ack["ok"], serde_json::json!(true));
        assert!(ack["providers"].as_array().unwrap().is_empty());
    }
}
