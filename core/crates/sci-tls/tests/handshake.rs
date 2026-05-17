//! End-to-end: a leaf cert minted by our `CertResolver` validates against
//! the local CA when it's added to a rustls client's trust pool.
//!
//! Driven via rustls's non-IO `ServerConnection` / `ClientConnection`
//! types — same handshake state machine, no sockets, no async runtime.
//! Cleanest way to assert "the server-side TLS we configure for the
//! NetworkExtension to feed will actually accept connections from real
//! AI SDKs whose clients have been told to trust our CA."

use sci_tls::{ensure_ca, make_server_config};

use rustls::client::{ClientConfig, ClientConnection};
use rustls::pki_types::CertificateDer;
use rustls::server::ServerConnection;
use rustls::RootCertStore;
use std::sync::Arc;

#[test]
fn fresh_ca_signs_leaf_validated_by_local_trust_pool() {
    let dir = tempfile::tempdir().unwrap();
    let ca  = Arc::new(ensure_ca(dir.path()).expect("ca generation"));

    // Build the server side of the world.
    let server_cfg = Arc::new(make_server_config(ca.clone()).unwrap());
    let mut server = ServerConnection::new(server_cfg).unwrap();

    // Build the client: trust *only* the local CA we just generated.
    // If a leaf was somehow signed by anything else, this client would
    // refuse the handshake — that's the property we want to pin.
    let mut roots = RootCertStore::empty();
    let mut pem   = ca.cert_pem.as_bytes();
    for cert in rustls_pemfile::certs(&mut pem) {
        roots.add(cert.unwrap()).unwrap();
    }
    let client_cfg = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    );
    let server_name = "api.anthropic.com".try_into().unwrap();
    let mut client = ClientConnection::new(client_cfg, server_name).unwrap();

    // Pump the handshake.
    pump(&mut client, &mut server).expect("handshake");

    assert!(!client.is_handshaking(), "client still handshaking");
    assert!(!server.is_handshaking(), "server still handshaking");

    // The handshake-time leaf cert should be the one our resolver minted
    // with CN = api.anthropic.com. We verify by pulling the peer chain
    // back out of the client connection.
    let chain: &[CertificateDer<'_>] = client.peer_certificates().expect("peer chain");
    assert!(!chain.is_empty(), "empty chain");
    // We expect [leaf, ca] — exactly two certs, leaf first.
    assert_eq!(chain.len(), 2, "expected leaf + CA, got {} certs", chain.len());
}

#[test]
fn ca_persists_across_ensure_calls() {
    // Same on-disk CA across two `ensure_ca` calls — confirms we
    // re-load from disk rather than overwrite (which would invalidate
    // the user's trust pool entry on every restart).
    let dir = tempfile::tempdir().unwrap();
    let ca1 = ensure_ca(dir.path()).unwrap();
    let ca2 = ensure_ca(dir.path()).unwrap();
    assert_eq!(ca1.cert_pem, ca2.cert_pem,
        "CA regenerated on second ensure_ca — would invalidate user trust");
}

#[test]
fn cert_files_get_correct_perms() {
    let dir = tempfile::tempdir().unwrap();
    let _ca = ensure_ca(dir.path()).unwrap();
    let key_meta = std::fs::metadata(dir.path().join("ca.key")).unwrap();
    let cert_meta = std::fs::metadata(dir.path().join("ca.crt")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(key_meta.permissions().mode() & 0o777, 0o600,
        "ca.key must be 0600 — it's a private signing key");
    assert_eq!(cert_meta.permissions().mode() & 0o777, 0o644,
        "ca.crt should be world-readable");
}

#[test]
fn distinct_hostnames_get_distinct_leaves() {
    // The CertResolver caches by SNI hostname. Two different SNIs in
    // sequence should get two distinct leaf certs (different CNs).
    let dir = tempfile::tempdir().unwrap();
    let ca  = Arc::new(ensure_ca(dir.path()).unwrap());

    let chain_for = |host: &'static str| -> Vec<u8> {
        let server_cfg = Arc::new(make_server_config(ca.clone()).unwrap());
        let mut server = ServerConnection::new(server_cfg).unwrap();

        let mut roots = RootCertStore::empty();
        let mut pem   = ca.cert_pem.as_bytes();
        for cert in rustls_pemfile::certs(&mut pem) { roots.add(cert.unwrap()).unwrap(); }
        let client_cfg = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let mut client =
            ClientConnection::new(client_cfg, host.try_into().unwrap()).unwrap();

        pump(&mut client, &mut server).expect("handshake");
        client.peer_certificates().unwrap()[0].as_ref().to_vec()
    };

    let a = chain_for("api.anthropic.com");
    let b = chain_for("api.openai.com");
    assert_ne!(a, b, "same leaf used for two different SNIs — SNI resolver broken");
}

// ── Handshake driver ───────────────────────────────────────────────────────
//
// rustls `ClientConnection` / `ServerConnection` expose `read_tls` /
// `write_tls` that move bytes into and out of an internal buffer; the
// handshake completes when both sides have processed all incoming
// records. We bounce bytes between them in memory until both stop
// wanting to read.

fn pump(client: &mut ClientConnection, server: &mut ServerConnection) -> std::io::Result<()> {
    let mut iters = 0;
    while client.is_handshaking() || server.is_handshaking() {
        // Drain client → server.
        let mut buf = Vec::new();
        while client.wants_write() {
            client.write_tls(&mut buf)?;
        }
        if !buf.is_empty() {
            let mut cursor = std::io::Cursor::new(&buf);
            while cursor.position() < buf.len() as u64 {
                server.read_tls(&mut cursor)?;
            }
            server.process_new_packets().map_err(|e| {
                std::io::Error::other(format!("server packet: {e}"))
            })?;
        }

        // Drain server → client.
        let mut buf = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut buf)?;
        }
        if !buf.is_empty() {
            let mut cursor = std::io::Cursor::new(&buf);
            while cursor.position() < buf.len() as u64 {
                client.read_tls(&mut cursor)?;
            }
            client.process_new_packets().map_err(|e| {
                std::io::Error::other(format!("client packet: {e}"))
            })?;
        }

        iters += 1;
        if iters > 16 {
            return Err(std::io::Error::other("handshake didn't converge"));
        }
    }
    Ok(())
}
