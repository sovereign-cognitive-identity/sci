//! Helper → app event channel (SCI-138).
//!
//! The macOS app needs visible feedback that Sci is doing something —
//! request counts, masked-entity counts, error rates. The helper has
//! that information at flow time. This module is the bridge:
//!
//!   * `Event` — the wire-format enum (one variant per event type).
//!     Serialized as JSON, one line per event. Field names are the
//!     contract; renaming any breaks the Swift consumer.
//!
//!   * `EventBus` — a `tokio::sync::broadcast` over `Event`. One
//!     producer (any helper task that emits), many consumers (each
//!     subscribed app session). Built once at helper startup, cloned
//!     into every flow handler.
//!
//!   * `Subscriber::run` — the per-app-connection consumer loop.
//!     `handle_session` calls this when it sees an
//!     `{"kind":"events"}` header. Streams events as JSON lines until
//!     the app disconnects.
//!
//! Why broadcast vs mpsc: an app may open multiple subscribers (the
//! menu bar + Settings pane both want events; or a future Console
//! tab); the helper shouldn't care how many. broadcast naturally
//! handles fan-out.

use anyhow::Result;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::broadcast;

/// Wire-format event. JSON-serialized one per line. Renaming any
/// `serde(rename = ...)` field is a breaking change to the app
/// consumer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Embedder load started. Helps the app distinguish "starting up
    /// quickly" from "downloading a big model".
    #[serde(rename = "embedder_loading")]
    EmbedderLoading,

    /// Embedder ready — control socket about to bind. The app's
    /// existing PING wait already covers this transition, but the
    /// explicit event is useful for diagnostic UIs.
    #[serde(rename = "embedder_ready")]
    EmbedderReady,

    /// New flow started — first line the menu-bar shows for "request
    /// in flight". Hostname is OS-resolved from the SNI/rule match.
    #[serde(rename = "flow_started")]
    FlowStarted { host: String, ts: i64 },

    /// Flow completed cleanly. `masked` is the count of anonymized
    /// entities — the `🔒 masked N` signal the menu bar surfaces.
    /// `ms` is the wall-clock duration of the helper's piece (TLS
    /// + dispatch + upstream + deanon, NOT including OS routing).
    #[serde(rename = "flow_completed")]
    FlowCompleted {
        host:   String,
        masked: u32,
        ms:     u32,
        status: u16,
        ts:     i64,
    },

    /// Flow ended with an error before/during dispatch. UI should
    /// surface as a red event row; aggregate count drives an alert
    /// state on the menu-bar icon if it crosses a threshold.
    #[serde(rename = "flow_error")]
    FlowError { host: String, error: String, ts: i64 },

    /// SCI-141: helper re-read `~/.sci/credentials.env` and swapped the
    /// live credential set. `providers` lists the names that now have
    /// a configured key (no key bytes). The Settings panel uses this
    /// to flip the "configured" indicators after a Save without waiting
    /// for the next request to land.
    #[serde(rename = "credentials_reloaded")]
    CredentialsReloaded { providers: Vec<String>, ts: i64 },

    /// SCI-138 inspector: the post-anonymization request body Sci
    /// forwarded upstream. Carries the bytes verbatim (UTF-8 string).
    /// Subscribers (sci-tail with `--bodies`, the Settings → Status
    /// pane) render this indented under the `flow_started` line so
    /// users can see exactly what left their machine.
    ///
    /// Always safe to log: by construction every PII entity has been
    /// replaced with a `[CLASS_N]` token before this event fires.
    #[serde(rename = "flow_anonymized_request")]
    FlowAnonymizedRequest { host: String, body: String, ts: i64 },

    /// SCI-138 inspector: the upstream response body Sci received,
    /// BEFORE the deanonymizer rewrote tokens back to entities. Same
    /// safety story (the bytes echo masked tokens; never user PII).
    /// Only emitted for non-streaming JSON responses today; SSE-chunk
    /// traces are a future enhancement.
    #[serde(rename = "flow_upstream_raw_response")]
    FlowUpstreamRawResponse { host: String, body: String, ts: i64 },
}

/// `tokio::sync::broadcast` capacity. Slow subscribers that fall
/// behind by more than this drop oldest events with a `Lagged` error
/// — the subscriber loop logs + recovers (we never block the producer).
const CHANNEL_CAPACITY: usize = 256;

/// Bus that the helper emits events into and subscribers consume from.
/// Cheap to clone; underlying broadcast::Sender is reference-counted.
#[derive(Clone)]
pub struct EventBus(broadcast::Sender<Event>);

impl EventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
        EventBus(tx)
    }

    /// Emit an event. `_ = send()` because the function returns
    /// `Err(SendError)` when there are no subscribers — that's normal,
    /// not a fault: the user might never open the app, or the event
    /// channel might be quiet between sessions. Drop silently.
    pub fn emit(&self, event: Event) {
        let _ = self.0.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self { Self::new() }
}

/// Per-subscriber drain loop. `handle_session` calls this after seeing
/// `{"kind":"events"}` on a connection.
pub async fn run_subscriber(mut stream: UnixStream, bus: &EventBus) -> Result<()> {
    let mut rx = bus.subscribe();

    // Prime the connection with a one-line ack so the app knows
    // subscription succeeded — useful for `EventConsumer.connect()`'s
    // readiness check.
    stream.write_all(b"{\"type\":\"subscribed\"}\n").await?;

    loop {
        match rx.recv().await {
            Ok(event) => {
                let line = serde_json::to_string(&event)?;
                stream.write_all(line.as_bytes()).await?;
                stream.write_all(b"\n").await?;
                stream.flush().await?;
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // Subscriber fell behind; broadcast dropped `n` events.
                // Log on the helper side; continue rather than dropping
                // the connection. Lost events are a UX nit, not a bug.
                tracing::debug!("event subscriber lagged by {n}");
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Bus shutting down — clean exit.
                return Ok(());
            }
        }
    }
}

/// Wall-clock millis since UNIX epoch, for event `ts` fields. i64 so
/// the JSON serializes as a regular number; will overflow in 2^63 / 1k
/// / 86400 / 365.25 ≈ 292 million years (we have time).
pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
