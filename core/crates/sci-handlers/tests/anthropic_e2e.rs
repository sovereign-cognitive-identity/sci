//! End-to-end handler test: PII goes in, masked PII reaches upstream,
//! deanonymized PII comes back to the client.
//!
//! Mocks the upstream so we don't need network. Asserts both
//! directions of the anonymization round-trip in one go — the property
//! that matters most for v0.5 dogfood and is the easiest to regress
//! on accidentally.

use bytes::Bytes;
use futures::{StreamExt, stream};
use sci_handlers::{
    Embedder, HandlerRequest, HandlerState, NoopEmbedder, UpstreamClient, handle_anthropic_messages,
};
use sci_handlers::{HandlerError, Result};
use sci_memory::LocalAdapter;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

/// Mock upstream: capture what the handler forwarded so the test can
/// assert against it; replay a canned SSE response back.
struct MockUpstream {
    captured: Mutex<Vec<sci_handlers::HandlerRequest>>,
    response: Mutex<Option<Vec<u8>>>,
}

impl MockUpstream {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            captured: Mutex::new(Vec::new()),
            response: Mutex::new(None),
        })
    }
    fn set_response(&self, body: &[u8]) {
        *self.response.lock().unwrap() = Some(body.to_vec());
    }
    fn captured_url(&self) -> Option<String> {
        self.captured.lock().unwrap().first().map(|r| r.url.clone())
    }
    fn captured_body(&self) -> Option<Bytes> {
        self.captured.lock().unwrap().first().map(|r| r.body.clone())
    }
}

#[async_trait::async_trait]
impl UpstreamClient for MockUpstream {
    async fn send(
        &self,
        req: sci_handlers::upstream::UpstreamRequest,
    ) -> std::result::Result<sci_handlers::upstream::UpstreamResponse, std::io::Error> {
        // Stash a HandlerRequest-shaped record for assertions. We
        // build it fresh because UpstreamRequest doesn't carry the
        // hostname separately — the URL has it.
        self.captured.lock().unwrap().push(HandlerRequest {
            method:   req.method,
            url:      req.url.clone(),
            headers:  req.headers,
            body:     req.body,
            hostname: req.url.split('/').nth(2).unwrap_or("").to_string(),
        });
        let body = self
            .response
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        let stream: Pin<Box<dyn futures::Stream<Item = std::io::Result<Bytes>> + Send>> =
            Box::pin(stream::iter(vec![Ok(Bytes::from(body))]));
        // Mirror real Anthropic's response-side content-type so the
        // handler's SSE-vs-JSON branch (added with the non-streaming
        // deanon path) routes through the SSE deanonymizer. Without
        // this, the canned SSE bytes would land in the JSON path
        // and the test would see masked tokens instead of restored
        // entities.
        let mut headers = HashMap::new();
        headers.insert("content-type".into(), "text/event-stream".into());
        Ok(sci_handlers::upstream::UpstreamResponse {
            status:  200,
            headers,
            body:    stream,
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn round_trip_masks_outbound_and_deanonymizes_inbound() {
    // ── Set up state ──────────────────────────────────────────────────────
    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
    let embedder: Arc<dyn Embedder> = Arc::new(NoopEmbedder);
    let upstream = MockUpstream::new();
    let state    = Arc::new(HandlerState::new(
        storage,
        embedder,
        upstream.clone() as Arc<dyn UpstreamClient>,
    ));

    // ── Build the inbound request: contains a CamelCase project name
    //    and a URL, both of which the deterministic anonymizer catches.
    let user_text = "We just shipped OpenClaw on openclaw.dev — what next?";
    let body = serde_json::json!({
        "model":      "claude-haiku-4-5",
        "max_tokens": 100,
        "messages": [{ "role": "user", "content": user_text }],
    });

    // ── Pre-stage the upstream's reply: includes the masked tokens
    //    as if Claude echoed them. The deanonymizer should swap them
    //    back before the test sees the bytes.
    //
    //    We anonymize once locally to discover what tokens the handler
    //    will mint (PROJECT_1, URL_1) so we can reference them by
    //    name in the mock SSE response. Real upstream echoes whatever
    //    masked tokens arrive in the prompt.
    let preview = sci_anonymizer::anonymize(user_text, None);
    let project_token = preview.token_map.forward.get("OpenClaw").unwrap().clone();
    let url_token     = preview.token_map.forward.get("openclaw.dev").unwrap().clone();
    let canned_sse = format!(
        "event: content_block_delta\n\
         data: {{\"type\":\"content_block_delta\",\"index\":0,\
         \"delta\":{{\"type\":\"text_delta\",\"text\":\"yes {project_token} on {url_token} looks great\"}}}}\n\n\
         event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n",
    );
    upstream.set_response(canned_sse.as_bytes());

    // ── Build the request the handler sees ────────────────────────────────
    let mut headers = HashMap::new();
    headers.insert("x-api-key".into(), "sk-ant-fake".into());
    let req = HandlerRequest {
        method:   "POST".into(),
        url:      "/v1/messages".into(),
        headers,
        body:     serde_json::to_vec(&body).unwrap().into(),
        hostname: "api.anthropic.com".into(),
    };

    // ── Run the handler ────────────────────────────────────────────────────
    let resp = handle_anthropic_messages(req, state).await.expect("handler ok");
    assert_eq!(resp.status, 200);

    // ── Outbound assertion: the body forwarded upstream contains the
    //    masked tokens, not the original entities ────────────────────────
    let forwarded = upstream.captured_body().expect("upstream got a body");
    let forwarded_str = std::str::from_utf8(&forwarded).unwrap();
    assert!(
        !forwarded_str.contains("OpenClaw"),
        "OpenClaw leaked to upstream: {forwarded_str}",
    );
    assert!(
        !forwarded_str.contains("openclaw.dev"),
        "openclaw.dev leaked to upstream: {forwarded_str}",
    );
    assert!(forwarded_str.contains("[PROJECT_") || forwarded_str.contains("[URL_"));
    assert_eq!(
        upstream.captured_url(),
        Some("https://api.anthropic.com/v1/messages".to_string()),
    );

    // ── Inbound assertion: the bytes streaming back to the client
    //    have tokens swapped back to the original entities ───────────────
    let mut downstream = resp.body;
    let mut buf = Vec::new();
    while let Some(chunk) = downstream.next().await {
        buf.extend_from_slice(&chunk.unwrap());
    }
    let downstream_str = std::str::from_utf8(&buf).unwrap();
    assert!(
        downstream_str.contains("yes OpenClaw on openclaw.dev looks great"),
        "expected deanonymized text in stream, got: {downstream_str}",
    );
    assert!(
        !downstream_str.contains(&project_token),
        "PROJECT token leaked to downstream client: {downstream_str}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn round_trip_persists_user_message_to_episodic_memory() {
    // SCI-130: confirm the storage write fires after a successful
    // round-trip, with the ORIGINAL (pre-anonymization) user text.
    // Multi-thread runtime because `spawn_store_interaction` lives on
    // a separate task.
    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
    // Bootstrap the 'work' profile (the handler's default storage
    // target). LocalAdapter::open seeds 'work' and 'personal' for new
    // DBs; we confirm here so the test fails loudly if that contract
    // breaks rather than producing a silent no-op.
    {
        let s = storage.lock().unwrap();
        let p = s.get_profile("work")
            .expect("get_profile ok")
            .expect("'work' profile must exist after open()");
        assert_eq!(p.name, "work");
    }

    let embedder: Arc<dyn Embedder> = Arc::new(NoopEmbedder);
    let upstream = MockUpstream::new();
    let state    = Arc::new(HandlerState::new(
        storage.clone(),
        embedder,
        upstream.clone() as Arc<dyn UpstreamClient>,
    ));

    // Long-enough user text (>20 chars) so it clears the storage
    // threshold. Contains a real name to exercise the "store the
    // unmasked original" contract — if the handler accidentally
    // stored the post-anonymize body, this assertion would fail.
    let user_text = "Reminder: my favorite project is openclaw.dev and my name is Casey.";
    let body = serde_json::json!({
        "model":      "claude-haiku-4-5",
        "max_tokens": 50,
        "messages":   [{ "role": "user", "content": user_text }],
    });

    let preview = sci_anonymizer::anonymize(user_text, None);
    let url_token = preview.token_map.forward.get("openclaw.dev").unwrap().clone();
    let canned_sse = format!(
        "event: content_block_delta\n\
         data: {{\"type\":\"content_block_delta\",\"index\":0,\
         \"delta\":{{\"type\":\"text_delta\",\"text\":\"got it, {url_token}\"}}}}\n\n\
         event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n",
    );
    upstream.set_response(canned_sse.as_bytes());

    let mut headers = HashMap::new();
    headers.insert("x-api-key".into(), "sk-ant-fake".into());
    let req = HandlerRequest {
        method:   "POST".into(),
        url:      "/v1/messages".into(),
        headers,
        body:     serde_json::to_vec(&body).unwrap().into(),
        hostname: "api.anthropic.com".into(),
    };

    let resp = handle_anthropic_messages(req, state).await.expect("handler ok");
    // Drain the response stream so the dispatcher returns and the
    // spawned store task has a chance to run.
    let mut downstream = resp.body;
    while let Some(chunk) = downstream.next().await {
        let _ = chunk.unwrap();
    }

    // The store is fire-and-forget on a tokio::spawn — give it a
    // moment to land. With NoopEmbedder + in-memory SQLite this is
    // sub-millisecond, but the scheduler still has to tick.
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let s = storage.lock().unwrap();
        if s.get_stats().unwrap().episodic >= 1 {
            break;
        }
    }

    // Final assertion: exactly one episodic row, content == original
    // (un-anonymized) user text.
    let s = storage.lock().unwrap();
    let stats = s.get_stats().expect("get_stats");
    assert_eq!(
        stats.episodic, 1,
        "expected 1 episodic memory after a successful round-trip, got {}",
        stats.episodic,
    );

    let profile = s.get_profile("work").unwrap().unwrap();
    let query_emb = vec![0.0f32; 768]; // matches NoopEmbedder dim
    let hits = s.recall(&sci_memory::RecallQuery {
        query_embedding: &query_emb,
        query:           "openclaw",
        profile_id:      &profile.id,
        limit:           5,
        types:           &[],
    }).expect("recall");
    assert!(
        hits.iter().any(|h| h.content == user_text),
        "expected stored content to match original (real names), got: {hits:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn short_user_messages_are_not_stored() {
    // 5-char threshold (dropped from 20 after dogfood; was filtering
    // real questions like "what's my email"). Trivial pings like
    // `"hi"` should still be skipped.
    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
    let embedder: Arc<dyn Embedder> = Arc::new(NoopEmbedder);
    let upstream = MockUpstream::new();
    let state    = Arc::new(HandlerState::new(
        storage.clone(),
        embedder,
        upstream.clone() as Arc<dyn UpstreamClient>,
    ));
    upstream.set_response(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");

    let body = serde_json::json!({
        "model":      "claude-haiku-4-5",
        "max_tokens": 5,
        "messages":   [{ "role": "user", "content": "hi" }],   // 2 chars
    });
    let mut headers = HashMap::new();
    headers.insert("x-api-key".into(), "sk-ant-fake".into());
    let req = HandlerRequest {
        method:   "POST".into(),
        url:      "/v1/messages".into(),
        headers,
        body:     serde_json::to_vec(&body).unwrap().into(),
        hostname: "api.anthropic.com".into(),
    };
    let resp = handle_anthropic_messages(req, state).await.expect("handler ok");
    let mut downstream = resp.body;
    while let Some(chunk) = downstream.next().await { let _ = chunk.unwrap(); }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let s = storage.lock().unwrap();
    assert_eq!(
        s.get_stats().unwrap().episodic, 0,
        "trivial pings should NOT be stored",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_automation_prompts_are_not_stored() {
    // Claude Code wraps internal meta-prompts as user-role messages
    // and fires them to /v1/messages. The handler must NOT mistake
    // these for real user turns and store them — they'd pollute the
    // recall corpus with thousands of "[SUGGESTION MODE: …]" entries.
    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
    let embedder: Arc<dyn Embedder> = Arc::new(NoopEmbedder);
    let upstream = MockUpstream::new();
    let state    = Arc::new(HandlerState::new(
        storage.clone(),
        embedder,
        upstream.clone() as Arc<dyn UpstreamClient>,
    ));
    upstream.set_response(
        b"event: content_block_delta\n\
         data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n\
         event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    // Real Claude Code suggestion-mode prompt structure (a verbatim
    // Casey-saw-this-in-his-DB excerpt, abbreviated).
    let auto_prompt =
        "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\n\
         FIRST: Look at the user's recent messages and original request.\n\
         Your job is to predict what THEY would type — not what you think they should do.";

    let body = serde_json::json!({
        "model":      "claude-haiku-4-5",
        "max_tokens": 50,
        "messages":   [{ "role": "user", "content": auto_prompt }],
    });
    let mut headers = HashMap::new();
    headers.insert("x-api-key".into(), "sk-ant-fake".into());
    let req = HandlerRequest {
        method:   "POST".into(),
        url:      "/v1/messages".into(),
        headers,
        body:     serde_json::to_vec(&body).unwrap().into(),
        hostname: "api.anthropic.com".into(),
    };
    let resp = handle_anthropic_messages(req, state).await.expect("handler ok");
    let mut downstream = resp.body;
    while let Some(chunk) = downstream.next().await { let _ = chunk.unwrap(); }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let s = storage.lock().unwrap();
    assert_eq!(
        s.get_stats().unwrap().episodic, 0,
        "[SUGGESTION MODE: …] prompts must not be stored as user turns",
    );
}

#[tokio::test(flavor = "current_thread")]
async fn missing_credential_errors_cleanly() -> Result<()> {
    // Point the OAuth cache at an empty path so this test doesn't
    // depend on whether the dev machine has a `~/.sci/oauth.json`
    // (it would, otherwise, succeed by falling through to OAuth).
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("oauth-empty.json");
    // SAFETY: env-var mutation in a single-test binary; see sci-oauth
    // tests for the same pattern.
    unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }

    let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
    let embedder: Arc<dyn Embedder> = Arc::new(NoopEmbedder);
    let upstream = MockUpstream::new();
    let state    = Arc::new(HandlerState::new(
        storage,
        embedder,
        upstream as Arc<dyn UpstreamClient>,
    ));

    let body = serde_json::json!({
        "model":      "claude-haiku-4-5",
        "max_tokens": 50,
        "messages":   [{"role": "user", "content": "hi"}],
    });
    let req = HandlerRequest {
        method:   "POST".into(),
        url:      "/v1/messages".into(),
        headers:  HashMap::new(),  // no auth at all
        body:     serde_json::to_vec(&body).unwrap().into(),
        hostname: "api.anthropic.com".into(),
    };

    let err = handle_anthropic_messages(req, state).await.unwrap_err();
    assert!(matches!(err, HandlerError::MissingCredential { .. }));
    Ok(())
}
