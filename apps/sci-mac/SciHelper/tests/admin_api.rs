//! SCI-152 integration test: admin HTTP API end-to-end.
//!
//! Spins up the admin server in-process on a random port (bind to
//! 127.0.0.1:0 + read the assigned port), hits each endpoint via
//! reqwest, and asserts the JSON shape + SSE delivery.
//!
//! Uses NoopEmbedder + an in-memory LocalAdapter so the test is
//! hermetic (no model download, no on-disk DB). We do NOT spin up
//! the full helper main() — just the admin module — which keeps the
//! test fast (~50ms per case) and isolated from the proxy/Unix-socket
//! plumbing.

// Make the helper's internal modules visible to the integration test
// by declaring them inline. They're already `pub` for their own crates
// to use; this just brings them into scope as a library surface.
//
// NB: Rust's integration tests can only see what's exported as `pub`
// from the crate root. Since sci-helper is a binary crate, not a lib,
// we use the same trick the helper uses elsewhere: declare the
// modules as a sibling crate path. The simpler path is to depend on
// the helper as a path dep and have it expose admin via a lib. Since
// we don't have a lib target, we re-use the binary's modules by file
// inclusion — the standard #[path] pattern.

#[path = "../src/admin.rs"]
mod admin;

#[path = "../src/events.rs"]
mod events;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use sci_core::handlers::{HandlerState, NoopEmbedder, ReqwestClient};
use sci_core::memory::{
    LocalAdapter, StoreAuditTurnInput, TokenDirection, TokenMappingInput,
};

use admin::{AdminState, admin_router};
use events::{Event, EventBus};

/// Build an AdminState wired to an in-memory store + NoopEmbedder.
/// Returns the state + a handle to the storage so the test can seed
/// data + assert side-effects.
fn make_state() -> (AdminState, Arc<Mutex<LocalAdapter>>, EventBus) {
    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().expect("open")));
    let embedder = Arc::new(NoopEmbedder);
    let upstream = Arc::new(ReqwestClient::new().expect("reqwest"));
    let handler_state = Arc::new(HandlerState::new(storage.clone(), embedder, upstream));
    let events = EventBus::new();
    let state = AdminState {
        handler_state,
        events: events.clone(),
        version: "test-0.0.0",
        started_at: std::time::Instant::now(),
    };
    (state, storage, events)
}

/// Spawn the admin server on a random port. Returns the base URL like
/// `http://127.0.0.1:54321` so tests can hit endpoints relatively.
async fn spawn(state: AdminState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, admin_router(state)).await.unwrap();
    });
    // Tiny pause so the server's accept loop is actually ready before
    // the first reqwest call. The bind is synchronous so a microtask
    // tick is plenty — but tokio::yield_now() alone is racy on macOS.
    tokio::time::sleep(Duration::from_millis(20)).await;
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_returns_version_uptime_and_stats() {
    let (state, _storage, _events) = make_state();
    let base = spawn(state).await;

    let body: serde_json::Value = reqwest::get(format!("{base}/sci/status"))
        .await.unwrap()
        .json().await.unwrap();

    assert_eq!(body["version"], "test-0.0.0");
    assert!(body["uptimeSeconds"].is_u64());
    assert_eq!(body["stats"]["auditTurns"], 0);
    assert_eq!(body["stats"]["episodic"],   0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_turns_list_get_count_round_trip() {
    let (state, storage, _events) = make_state();
    // Seed one turn with a known token mapping.
    let turn_id = {
        let s = storage.lock().unwrap();
        let work = s.get_profile("work").unwrap().unwrap();
        s.store_audit_turn(&StoreAuditTurnInput {
            profile_id:     Some(&work.id),
            host:           "api.anthropic.com",
            endpoint:       "/v1/messages",
            model:          Some("claude-haiku-4-5"),
            user_text:      Some("Hi from Casey"),
            assistant_text: Some("Hey Casey"),
            masked_count:   1,
            status:         Some(200),
            latency_ms:     Some(42),
            token_mappings: vec![TokenMappingInput {
                token: "[PERSON_1]", original: "Casey",
                entity_kind: "PERSON", direction: TokenDirection::Outbound,
            }],
            ..Default::default()
        }).unwrap()
    };

    let base = spawn(state).await;

    // list
    let list: Vec<serde_json::Value> =
        reqwest::get(format!("{base}/sci/audit_turns?limit=10"))
            .await.unwrap().json().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["host"],         "api.anthropic.com");
    assert_eq!(list[0]["model"],        "claude-haiku-4-5");
    assert_eq!(list[0]["maskedCount"],  1);

    // get one
    let one: serde_json::Value =
        reqwest::get(format!("{base}/sci/audit_turns/{turn_id}"))
            .await.unwrap().json().await.unwrap();
    assert_eq!(one["turn"]["id"], turn_id);
    assert_eq!(one["mappings"].as_array().unwrap().len(), 1);
    assert_eq!(one["mappings"][0]["original"], "Casey");

    // count
    let count: serde_json::Value =
        reqwest::get(format!("{base}/sci/audit_turns/count?original=Casey"))
            .await.unwrap().json().await.unwrap();
    assert_eq!(count["count"], 1);
    assert_eq!(count["original"], "Casey");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_audit_turn_returns_404_for_unknown_id() {
    let (state, _storage, _events) = make_state();
    let base = spawn(state).await;
    let resp = reqwest::get(format!("{base}/sci/audit_turns/no-such-id"))
        .await.unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn profiles_endpoint_lists_seeded_profiles() {
    let (state, _storage, _events) = make_state();
    let base = spawn(state).await;
    let body: Vec<serde_json::Value> = reqwest::get(format!("{base}/sci/profiles"))
        .await.unwrap().json().await.unwrap();
    let names: Vec<&str> = body.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"work"));
    assert!(names.contains(&"personal"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_profile_round_trips_and_creating_new_profile_works() {
    // SCI-156: GET /sci/active_profile defaults to "work"; POSTing
    // changes it. POST /sci/profiles creates a new one. The new
    // profile then shows in /sci/profiles.
    let (state, _storage, _events) = make_state();
    let base = spawn(state).await;

    // Default
    let initial: serde_json::Value = reqwest::get(format!("{base}/sci/active_profile"))
        .await.unwrap().json().await.unwrap();
    assert_eq!(initial["name"], "work");

    // Switch
    let client = reqwest::Client::new();
    let switched: serde_json::Value = client
        .post(format!("{base}/sci/active_profile"))
        .json(&serde_json::json!({"name": "personal"}))
        .send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(switched["name"], "personal");

    // Read-back confirms
    let read_back: serde_json::Value = reqwest::get(format!("{base}/sci/active_profile"))
        .await.unwrap().json().await.unwrap();
    assert_eq!(read_back["name"], "personal");

    // Create a new profile + verify it appears in the list
    let created: serde_json::Value = client
        .post(format!("{base}/sci/profiles"))
        .json(&serde_json::json!({"name": "project-foo"}))
        .send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(created["name"], "project-foo");

    let profiles: Vec<serde_json::Value> = reqwest::get(format!("{base}/sci/profiles"))
        .await.unwrap().json().await.unwrap();
    let names: Vec<&str> = profiles.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"project-foo"));

    // Empty name → 400
    let bad = client
        .post(format!("{base}/sci/active_profile"))
        .json(&serde_json::json!({"name": "  "}))
        .send().await.unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_sse_delivers_emitted_events() {
    use futures::StreamExt;
    let (state, _storage, events) = make_state();
    let base = spawn(state).await;

    // Subscribe in a background task so we can race the emit against
    // the connection establishment without flakiness.
    let url = format!("{base}/sci/events");
    let handle: tokio::task::JoinHandle<String> = tokio::spawn(async move {
        let resp = reqwest::get(url).await.unwrap();
        assert_eq!(resp.status(), 200);
        let ct = resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(ct.starts_with("text/event-stream"), "got content-type: {ct}");
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.unwrap();
            buf.push_str(std::str::from_utf8(&bytes).unwrap());
            if buf.contains("flow_completed") {
                break;
            }
        }
        buf
    });

    // Give the subscriber a moment to connect, then emit.
    tokio::time::sleep(Duration::from_millis(80)).await;
    events.emit(Event::FlowCompleted {
        host:   "api.anthropic.com".into(),
        masked: 2,
        ms:     100,
        status: 200,
        ts:     events::now_ts(),
    });

    let payload = tokio::time::timeout(Duration::from_secs(3), handle)
        .await.expect("sse deadline").unwrap();
    assert!(payload.contains("flow_completed"), "got: {payload}");
    assert!(payload.contains("api.anthropic.com"));
}
