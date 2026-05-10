//! sci-helper — long-running Rust binary that hosts the Sci engine.
//!
//! Lifecycle:
//!
//!   1. The macOS .app spawns this as a child process at launch with
//!      `SCI_CONFIG_DIR` + `SCI_HELPER_SOCKET` set in env.
//!   2. We init the engine (CA + memory store + handler state +
//!      rustls server config), bind the Unix control socket, and
//!      accept connections in a loop.
//!   3. Each connection is either:
//!      - a `PING`/`PONG` line (Settings panel's helper-status check), or
//!      - a flow handover from the NetworkExtension — JSON header,
//!        then TLS bytes the helper terminates on its end.
//!
//!      `flow::handle_session` does the dispatch + per-flow pipeline.
//!
//! See `flow.rs` for the SCI-134 protocol details. Phase 1 was a bare
//! PING/PONG smoke loop; phase 2 (this) wires the real engine.

mod credentials;
mod events;
mod flow;
mod proxy;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::UnixListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio_rustls::TlsAcceptor;

use sci_core::BgeEmbedder;
use sci_core::handlers::{HandlerState, ReqwestClient};
use sci_core::memory::LocalAdapter;
use sci_core::tls::{ensure_ca, make_server_config};

use crate::credentials::load_credentials;
use crate::events::{Event, EventBus};
use crate::flow::{SharedState, handle_session};

/// Default config dir. Matches the TS agent's `~/.sci/` so a user can
/// move between the two without re-trusting the CA.
fn default_config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("SCI_CONFIG_DIR") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".sci")
}

/// Default control socket location. The NE sets this explicitly before
/// connecting; this fallback is for `sci-helper --foreground` runs from
/// a developer terminal.
fn default_socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SCI_HELPER_SOCKET") {
        return PathBuf::from(p);
    }
    default_config_dir().join("helper.sock")
}

/// SCI-148: parse the optional `--proxy <port>` CLI arg, falling back
/// to `SCI_HELPER_PROXY_PORT`. Returns `Some(port)` if either is set.
/// We keep the arg parsing inline (no `clap` dependency) — the helper
/// has exactly two flags and pulling clap in for that bloats the
/// release binary.
fn parse_proxy_port() -> Option<u16> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--proxy" => {
                if let Some(p) = args.next()
                    && let Ok(n) = p.parse::<u16>() {
                    return Some(n);
                }
            }
            s if s.starts_with("--proxy=") => {
                if let Ok(n) = s["--proxy=".len()..].parse::<u16>() {
                    return Some(n);
                }
            }
            _ => {}
        }
    }
    std::env::var("SCI_HELPER_PROXY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    // Plain stderr logger — Console.app picks stderr up under the
    // helper's subsystem when launched from inside the .app, which is
    // the only audit channel the user has for what the engine is
    // doing. Default to INFO; let RUST_LOG override for debugging.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();

    let config_dir = default_config_dir();
    tokio::fs::create_dir_all(&config_dir)
        .await
        .with_context(|| format!("create config dir {}", config_dir.display()))?;

    tracing::info!(
        version    = sci_core::VERSION,
        config_dir = %config_dir.display(),
        "sci-helper starting"
    );

    // ── 1. Ensure CA exists ───────────────────────────────────────────────
    let ca = Arc::new(ensure_ca(&config_dir).context("ensure_ca")?);
    tracing::info!(cert = %config_dir.join("ca.crt").display(), "Sci CA loaded");

    // ── 2. Build the rustls ServerConfig (one for the process) ────────────
    // The acceptor is cheap to clone — its `Arc<ServerConfig>` is shared
    // across every flow. SNI resolver mints leaves on demand.
    let server_config = make_server_config(ca.clone()).context("make_server_config")?;
    let tls_acceptor  = TlsAcceptor::from(Arc::new(server_config));

    // ── 3. Open memory store + assemble HandlerState ──────────────────────
    let memory_dir = config_dir.join("memory");
    tokio::fs::create_dir_all(&memory_dir)
        .await
        .with_context(|| format!("create memory dir {}", memory_dir.display()))?;
    let db_path = memory_dir.join("sci.db");
    let storage = Arc::new(Mutex::new(
        LocalAdapter::open(&db_path).with_context(|| format!("open {}", db_path.display()))?,
    ));
    tracing::info!(db = %db_path.display(), "memory store ready");

    // SCI-138 event bus. Built early so the embedder-load + bind
    // phases below can emit through it. App subscribers connect on
    // the same socket with `{"kind":"events"}` once we're listening.
    let events = EventBus::new();

    // SCI-139: load `BgeEmbedder` BEFORE binding the control socket.
    // The Settings panel's "engine ready" check is the existing
    // PING/PONG loop, which can only succeed after we bind below.
    // Putting the load here means the app's spinner naturally covers
    // the model's first-run download (≈110 MB from HuggingFace) without
    // a bespoke progress channel. SCI-138 will surface byte-level
    // progress via the structured event channel; until then we log
    // each phase via `tracing::info!` so Console.app shows what's
    // happening.
    //
    // `BgeEmbedder::load()` checks `~/.sci/models/bge-base-en-v1.5/`
    // first and only hits the network if the cache is empty. Steady-
    // state launches are sub-second.
    tracing::info!("loading embedding model (first run will download ~110 MB)");
    events.emit(Event::EmbedderLoading);
    let embedder = match BgeEmbedder::load().await {
        Ok(e) => {
            tracing::info!("embedding model ready");
            events.emit(Event::EmbedderReady);
            Arc::new(e)
        }
        Err(e) => {
            // Hard fail rather than silently fall back to NoopEmbedder.
            // Recall would silently return empty hits and the user would
            // see "Sci has memory" in the UI but get nothing. Loud is
            // safer.
            return Err(anyhow::anyhow!(
                "BgeEmbedder::load failed: {e}. \
                 If HuggingFace is unreachable, set SCI_MODEL_CACHE_DIR \
                 to a directory with a pre-staged model + tokenizer."
            ));
        }
    };
    let upstream = Arc::new(
        ReqwestClient::new().context("build reqwest client")?,
    );
    let handler_state = Arc::new(HandlerState::new(storage, embedder, upstream));

    // SCI-128: BYO credential set, loaded at startup. SCI-141 made
    // this hot-reloadable via the `reload_credentials` IPC: the app
    // re-saves `~/.sci/credentials.env` and pings the helper, which
    // re-reads the file and `store()`s a fresh snapshot here. Reads
    // happen per-flow via `creds.load()` — single atomic, lock-free.
    let creds = load_credentials(&config_dir);
    tracing::info!("{}", creds.summary());
    let credentials = Arc::new(ArcSwap::from(Arc::new(creds)));

    let shared = SharedState {
        tls_acceptor,
        handler_state,
        events:      events.clone(),
        credentials,
        config_dir:  Arc::new(config_dir.clone()),
    };

    // ── 4. Bind control socket ────────────────────────────────────────────
    let socket_path = default_socket_path();
    // Best-effort cleanup of a stale socket from a prior crash.
    let _ = tokio::fs::remove_file(&socket_path).await;
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind unix socket {}", socket_path.display()))?;
    tracing::info!(socket = %socket_path.display(), "helper listening");

    // ── 4b. (SCI-148) Optional dev-proxy listener ─────────────────────────
    // `--proxy <port>` or `SCI_HELPER_PROXY_PORT=<port>` exposes the
    // engine as an explicit HTTPS proxy. Used for dogfood + CI
    // testing without the macOS NE entitlement, and as the
    // cross-platform capture surface (Linux/Windows have no NE).
    if let Some(port) = parse_proxy_port() {
        let addr = format!("127.0.0.1:{port}").parse().unwrap();
        let s = shared.clone();
        tokio::spawn(async move {
            if let Err(e) = proxy::serve_proxy(addr, s).await {
                tracing::error!(error = %e, "dev-proxy listener exited");
            }
        });
    }

    // ── 5. Accept loop until SIGTERM/SIGINT ───────────────────────────────
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint  = signal(SignalKind::interrupt())?;

    loop {
        tokio::select! {
            res = listener.accept() => {
                match res {
                    Ok((stream, _addr)) => {
                        let s = shared.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_session(stream, s).await {
                                // Per-connection errors (bad header,
                                // TLS handshake fail, malformed HTTP)
                                // are normal in adversarial conditions.
                                // Log + carry on; never crash the helper.
                                tracing::warn!(error = %e, "session ended with error");
                            }
                        });
                    }
                    Err(e) => tracing::warn!(error = %e, "accept failed"),
                }
            }
            _ = sigterm.recv() => { tracing::info!("SIGTERM, shutting down"); break; }
            _ = sigint.recv()  => { tracing::info!("SIGINT, shutting down");  break; }
        }
    }

    let _ = tokio::fs::remove_file(&socket_path).await;
    tracing::info!("sci-helper exiting cleanly");
    Ok(())
}
