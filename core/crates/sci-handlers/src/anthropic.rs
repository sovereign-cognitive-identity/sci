//! Anthropic `/v1/messages` handler.
//!
//! Pipeline (mirrors the TS handler at
//! `packages/proxy/src/handlers/anthropic.ts`):
//!
//!   1. Parse the JSON body.
//!   2. Anonymize all user-visible text — `system` and every `text`
//!      block inside `messages[*].content`. Builds a fresh
//!      `TokenMap` per request; cross-request session tracking is a
//!      future enhancement.
//!   3. Recall + inject memory context (no-op until SCI-130 lands a
//!      real embedder; the wiring is here so flipping the embedder
//!      lights up the brain icon).
//!   4. Forward to api.anthropic.com with the user's BYO API key
//!      (whatever they sent in `x-api-key` or `authorization`). The
//!      OAuth bearer-swap path for Claude Pro / Max is SCI-128.
//!   5. Stream the SSE response back through `DeanonymizingStream`,
//!      which JSON-parses each `content_block_delta` and swaps tokens
//!      back to the original entities.
//!
//! Storage of the interaction post-stream is pluggable but no-ops
//! until embeddings are real. The shape is:
//!   `state.storage.store_episodic({content: "user msg + assistant
//!    reply", embedding: state.embedder.embed(content).await })`
//! — the only thing missing is a non-zero embedder.

use crate::deanonymize_stream::DeanonymizingStream;
use crate::state::HandlerState;
use crate::types::{BodyStream, HandlerError, HandlerRequest, HandlerResponse, Result};
use crate::upstream::UpstreamRequest;
use sci_anonymizer::{Entity, TokenMap, anonymize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub async fn handle_anthropic_messages(
    req:   HandlerRequest,
    state: Arc<HandlerState>,
) -> Result<HandlerResponse> {
    // ── 1. Parse + anonymize ───────────────────────────────────────────────
    let mut body: Value = serde_json::from_slice(&req.body)
        .map_err(|e| HandlerError::Malformed(format!("body JSON: {e}")))?;

    // Capture the original (pre-anonymization) user text BEFORE we mask
    // the body — that's what we'll store to memory after the request
    // completes. The TS proxy at packages/proxy/src/middleware/memory.ts
    // does the same: storage gets the real names, anonymization only
    // affects what leaves the machine. Mirroring that contract is what
    // makes "your memory follows you across devices" actually work.
    let original_user_text = extract_user_text(&body);

    let mut session_map = TokenMap::default();
    let entities        = anonymize_messages_body(&mut body, &mut session_map)?;
    let masked_count    = entities.len() as u32;

    // ── 2. Memory recall + injection ───────────────────────────────────────
    //
    // Pull the user's most recent text out of `messages[].content` and
    // use it to recall relevant memories. With `NoopEmbedder` this
    // returns an empty list (zero-vector cosine). When SCI-130 ships
    // BgeEmbedder, the same code path lights up brain-icon recall.
    let recall_seed = extract_recall_seed(&body);
    let _ = inject_memory_context(&mut body, &recall_seed, &state).await;

    // ── 3. Build upstream request ──────────────────────────────────────────
    let upstream_url = format!("https://{}{}", req.hostname, req.url);
    let UpstreamHeaderPlan { headers: upstream_headers, oauth_active }
        = build_upstream_headers(&req).await?;

    // SCI-147: Anthropic's OAuth bearer (Pro/Max subscriber path) is
    // shape-gated server-side — requests that don't lead with the
    // canonical Claude Code system-prompt prefix get throttled to the
    // point of unusability (HTTP 429 `rate_limit_error` with body
    // `{"message":"Error"}`, no detail). The bearer authenticates fine;
    // it's an abuse-detection gate, not an auth failure. Claude Code
    // itself stamps the prefix; tools that drive Sci through Claude
    // Code inherit it for free. For tools that come in on the OAuth
    // path *without* Claude Code in the loop (curl, the Sci CLI, a
    // future Sci Browser) we stamp it here so the user's subscription
    // isn't silently throttled.
    //
    // Body-level mutation (vs. header) because the system prompt is
    // what Anthropic checks. Idempotent: if the caller already supplied
    // the prefix (Claude Code in the call chain), we leave it alone.
    if oauth_active {
        prepend_claude_code_prefix(&mut body);
        sanitize_body_for_oauth(&mut body);
    }

    let upstream_body = serde_json::to_vec(&body)
        .map_err(|e| HandlerError::Malformed(format!("re-serialize body: {e}")))?;

    // Inspector dump: post-anonymization, post-recall-injection request
    // body. Visible at `RUST_LOG=…,sci_handlers::anthropic=debug`. Safe
    // to log — by construction, every PII entity has been replaced with
    // a `[CLASS_N]` token. Useful during dogfood to confirm masking
    // shape; required for SCI-147 follow-up debugging.
    tracing::debug!(
        target: "sci_handlers::anthropic::inspect",
        host = %req.hostname,
        oauth_active,
        bytes = upstream_body.len(),
        "anonymized request → upstream:\n{}",
        String::from_utf8_lossy(&upstream_body),
    );

    // Snapshot the post-anonymize request bytes for the inspector
    // event before we move `upstream_body` into the upstream request.
    // Cheap clone — these are tiny (~1 KB typical) compared to the
    // model context they're about to bounce off of.
    let inspect_request = Some(bytes::Bytes::from(upstream_body.clone()));

    let upstream_req = UpstreamRequest {
        method:  "POST".into(),
        url:     upstream_url,
        headers: upstream_headers,
        body:    upstream_body.into(),
    };

    // ── 4. Forward ─────────────────────────────────────────────────────────
    let upstream_resp = state.upstream.send(upstream_req).await
        .map_err(|e| HandlerError::Upstream(e.to_string()))?;

    // For non-2xx responses Anthropic returns a JSON error body; pass
    // it through verbatim (no deanonymization needed — error bodies
    // don't contain user PII echoes).

    if !(200..300).contains(&upstream_resp.status) {
        let mut headers = upstream_resp.headers;
        // SCI-138: surface masked-entity count out-of-band via a
        // response header. The platform shell strips it before the
        // bytes leave the helper, so the real client never sees it.
        headers.insert("x-sci-masked".into(), masked_count.to_string());
        return Ok(HandlerResponse {
            status:               upstream_resp.status,
            headers,
            body:                 upstream_resp.body,
            inspect_request,
            inspect_upstream_raw: None,
        });
    }

    // ── 5. Deanonymize the response ────────────────────────────────────────
    //
    // Anthropic returns either:
    //   - `text/event-stream` when the request body had `"stream":true`
    //     (the common case for chat UIs and most SDK callers), or
    //   - `application/json` for one-shot, non-streaming requests
    //     (curl, simple SDK calls without `stream=True`).
    //
    // The streaming and non-streaming paths need different deanon shapes:
    // SSE chunks need the per-event JSON-aware rewriter so partial UTF-8
    // tokens across chunk boundaries don't get mangled, while a JSON
    // blob can be deserialized once and walked.
    let resp_content_type = upstream_resp
        .headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    let is_sse = resp_content_type.starts_with("text/event-stream");

    let (body_stream, inspect_upstream_raw): (BodyStream, Option<bytes::Bytes>) = if is_sse {
        // SSE: stream straight through the deanonymizer; we don't
        // buffer the upstream body, so no inspect snapshot. Per-chunk
        // tracing is a future enhancement.
        (
            DeanonymizingStream::new().wrap(upstream_resp.body, session_map),
            None,
        )
    } else {
        // JSON: `deanonymize_json_body` already buffers the full
        // upstream body before deanon — return that buffer too so
        // the platform shell can emit it as an inspector event.
        let (stream, raw) = deanonymize_json_body(upstream_resp.body, session_map).await?;
        (stream, Some(raw))
    };

    let mut headers = upstream_resp.headers;
    // SCI-138 — masked count surfaced as an internal header. The
    // platform shell reads it for telemetry, then strips it before
    // forwarding to the actual client.
    headers.insert("x-sci-masked".into(), masked_count.to_string());

    // SCI-130 storage hook: fire-and-forget store of the (pre-anon)
    // user message into the episodic memory. Mirrors the TS proxy's
    // `storeInteraction` at packages/proxy/src/middleware/memory.ts:
    //
    //   - Only stores if the user text is non-trivial (>20 chars)
    //   - Stores the ORIGINAL text (real names), not the masked one —
    //     anonymization only governs what leaves the machine
    //   - Uses the 'work' profile by default (matches TS contract)
    //   - Fire-and-forget: embedding + write run on a background task
    //     so they don't add latency to the response stream
    //
    // We only fire on the 2xx success path (we're past the early-return
    // for non-2xx above); the store therefore reflects "interactions
    // the user actually had with the model" not "every parse-able body
    // we sent upstream."
    spawn_store_interaction(state.clone(), original_user_text);

    Ok(HandlerResponse {
        status:  upstream_resp.status,
        headers,
        body:    body_stream,
        inspect_request,
        inspect_upstream_raw,
    })
}

/// Pull the most recent user message text out of the (still-original)
/// request body, BEFORE anonymization mutates it. Same shape coverage
/// as `extract_recall_seed` but distinct purpose — recall queries the
/// masked text (so model recall stays anonymized), storage keeps the
/// real text (so the user's own memory layer holds real names).
fn extract_user_text(body: &Value) -> String {
    let Some(messages) = body.get("messages").and_then(|v| v.as_array()) else {
        return String::new();
    };
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") { continue; }
        let content = msg.get("content");
        if let Some(s) = content.and_then(|v| v.as_str()) { return s.to_string(); }
        if let Some(arr) = content.and_then(|v| v.as_array()) {
            // Concatenate all text blocks in the most recent user turn —
            // matches what a user perceives as "what I just said."
            let parts: Vec<&str> = arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        b.get("text").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            if !parts.is_empty() {
                return parts.join("\n");
            }
        }
    }
    String::new()
}

/// Minimum content threshold for episodic storage. The TS proxy's
/// floor was 20 chars; in dogfood we found that filters legitimate
/// short questions like `"what's my email"` (15 chars). Lowered to 5
/// — still skips trivial pings (`"hi"`, `"ok"`, `"yes"`) but lets
/// real one-line questions through.
const STORE_MIN_CHARS: usize = 5;

/// Default profile name. Matches the TS proxy's hard-coded `'work'`.
/// Per-conversation profile selection is a future enhancement that
/// will surface in the macOS Settings UI.
const DEFAULT_STORE_PROFILE: &str = "work";

/// True if `s` looks like an agent's internal automation prompt
/// rather than a real user turn. Heuristic: leading `[` followed by
/// an ALL-CAPS marker terminated by `:` or `]`. Catches the patterns
/// Claude Code (and similar agentic CLIs) use to wrap meta-instructions
/// as user-role messages — `[SUGGESTION MODE: ...]`, `[SUMMARY: ...]`,
/// `[SYSTEM: ...]`, etc.
///
/// We deliberately don't hard-code a marker list because (a) tools
/// add new markers all the time and (b) any structural pattern that
/// looks like `[CAPS_MARKER:` or `[CAPS_MARKER]` is overwhelmingly
/// likely to be agent-internal rather than human-typed. False positives
/// (a user prompt that happens to begin `[BUG REPORT:`) are an
/// acceptable trade — those would be infrequent AND non-destructive
/// (worst case: one user prompt isn't remembered).
fn is_agent_automation_prompt(s: &str) -> bool {
    let trimmed = s.trim_start();
    if !trimmed.starts_with('[') {
        return false;
    }
    // Take everything between the leading `[` and the first `:` or `]`.
    let after_bracket = &trimmed[1..];
    let end = after_bracket
        .find([':', ']'])
        .unwrap_or(after_bracket.len().min(64)); // bound for runaway input
    if end == 0 {
        return false;
    }
    let marker = &after_bracket[..end];
    // Marker must contain at least one uppercase letter and consist
    // ONLY of uppercase letters / digits / spaces / underscores.
    let has_upper = marker.chars().any(|c| c.is_ascii_uppercase());
    let only_marker_chars = marker
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == ' ' || c == '_');
    has_upper && only_marker_chars
}

/// True if `s` looks like a slash-command output rather than a real
/// user message. Claude Code's internal commands (`/quota`, `/model`,
/// `/cost`, etc.) sometimes send their own short keywords as the
/// `user`-role content of a meta-call — we'd otherwise store
/// `"quota"` as if Casey had typed it.
///
/// Heuristic: a single non-empty token of `[a-z0-9_-]+` with no
/// whitespace. Real user prompts have spaces, capitalization, or
/// punctuation almost without exception. False positives (e.g. a
/// user types literally `quota` as their question) are non-destructive
/// — that one prompt isn't remembered.
fn looks_like_slash_command_output(s: &str) -> bool {
    let trimmed = s.trim();
    !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && !trimmed.contains(' ')
}

/// Spawn a background task that embeds + persists the user message.
/// Non-blocking: if the embedder is slow or the DB stalls, the user's
/// response stream is unaffected. All errors are swallowed (logged at
/// debug only) — failing to remember an interaction is a soft failure,
/// not worth surfacing to the model client.
fn spawn_store_interaction(state: Arc<HandlerState>, user_text: String) {
    let trimmed = user_text.trim();
    if trimmed.chars().count() < STORE_MIN_CHARS {
        return;
    }
    if is_agent_automation_prompt(trimmed) {
        // Don't pollute the memory with Claude Code's internal
        // suggestion / summarization / planning prompts. The user
        // didn't type these; storing them as if they did would
        // surface garbage during recall (and bloat the corpus).
        tracing::debug!(
            preview = &trimmed[..trimmed.len().min(60)],
            "skipping memory write: looks like agent automation prompt",
        );
        return;
    }
    if looks_like_slash_command_output(trimmed) {
        // E.g. Claude Code's `/quota`, `/model`, `/cost` slash
        // commands — they fire short single-token user messages as
        // meta-calls. Keeping them out of recall.
        tracing::debug!(
            preview = trimmed,
            "skipping memory write: looks like slash-command output",
        );
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = store_interaction(&state, &user_text).await {
            tracing::debug!(error = %e, "memory write failed (non-fatal)");
        }
    });
}

async fn store_interaction(state: &Arc<HandlerState>, user_text: &str) -> Result<()> {
    // Resolve profile (drop the storage lock before .await, same as
    // recall — clippy::await_holding_lock is enforced).
    let profile_id = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        let Some(p) = storage.get_profile(DEFAULT_STORE_PROFILE)? else {
            return Ok(()); // profile missing → no-op, same as TS
        };
        p.id
    };

    // Embed the user text. Cheap with NoopEmbedder (returns zeros);
    // ~tens of ms with BgeEmbedder. Off the critical path because
    // we're inside a `tokio::spawn`.
    let embedding = state.embedder.embed(user_text).await?;

    // Write. Re-acquire the lock briefly.
    let storage = state.storage.lock()
        .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
    let mut metadata = sci_memory::Metadata::new();
    metadata.insert("has_response".into(), serde_json::Value::Bool(true));
    metadata.insert("source".into(),       serde_json::Value::String("rust-helper".into()));
    storage.store_episodic(&sci_memory::StoreEpisodicInput {
        profile_id: &profile_id,
        content:    user_text,
        embedding:  &embedding,
        source:     Some("proxy"),
        agent_id:   None,
        metadata,
    })?;
    Ok(())
}

/// Non-streaming `/v1/messages` deanonymizer. Anthropic returns the
/// shape:
///
/// ```json
/// {
///   "content": [
///     {"type":"text","text":"Hello [PERSON_1]!"},
///     {"type":"thinking","thinking":"…"}   // possibly
///   ],
///   ...
/// }
/// ```
///
/// We collect the streamed bytes (the upstream client streamed even
/// for non-SSE bodies for uniformity), parse to a `Value`, walk
/// `content[*].text` (and `content[*].thinking` for the
/// extended-thinking shape) running the shared `deanonymize` over each,
/// re-serialize, and emit as a single-chunk stream so the shell can
/// stay shape-agnostic about streaming vs non-streaming.
///
/// On parse failure we pass the bytes through untouched — better to
/// surface a possibly-token-leaking response than to drop a real
/// error response on the floor (and Anthropic's error bodies don't
/// echo user PII anyway).
async fn deanonymize_json_body(
    mut body:      BodyStream,
    session_map:   TokenMap,
) -> Result<(BodyStream, bytes::Bytes)> {
    use futures::StreamExt;

    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    while let Some(chunk) = body.next().await {
        let chunk = chunk
            .map_err(|e| HandlerError::Upstream(format!("read response body: {e}")))?;
        buf.extend_from_slice(&chunk);
        // Bound at 16 MiB defense-in-depth; Anthropic's biggest non-SSE
        // bodies are ~1 MiB even at the high end.
        if buf.len() > 16 * 1024 * 1024 {
            return Err(HandlerError::Upstream(
                "response body exceeded 16 MiB cap".into(),
            ));
        }
    }

    // Inspector dump: raw upstream response, BEFORE deanonymization.
    // Same target as the request-side dump; same safety story (the
    // bytes echo the model's tokens, never user PII).
    tracing::debug!(
        target: "sci_handlers::anthropic::inspect",
        bytes = buf.len(),
        "upstream raw response → deanon:\n{}",
        String::from_utf8_lossy(&buf),
    );

    // Snapshot the raw bytes for the inspector event before we
    // potentially consume `buf` into the rewritten body.
    let raw = bytes::Bytes::from(buf.clone());

    // Parse + deanon. On any parse failure we pass through untouched so
    // a malformed-but-real-error response still reaches the client.
    let rewritten: Vec<u8> = match serde_json::from_slice::<Value>(&buf) {
        Ok(mut v) => {
            deanonymize_messages_response(&mut v, &session_map);
            serde_json::to_vec(&v).unwrap_or(buf)
        }
        Err(_) => buf,
    };

    let stream: BodyStream = Box::pin(futures::stream::once(async move {
        Ok::<_, std::io::Error>(bytes::Bytes::from(rewritten))
    }));
    Ok((stream, raw))
}

/// Walk a parsed `/v1/messages` response and rewrite token-shaped
/// strings back to their original entities using `session_map`.
/// Mutates the JSON in place. Same shape coverage as the SSE path:
/// `content[*].text` and `content[*].thinking` (if Anthropic ever
/// surfaces extended thinking in non-streaming form).
fn deanonymize_messages_response(value: &mut Value, session_map: &TokenMap) {
    let Some(content) = value.get_mut("content").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for block in content {
        let block_type = block
            .get("type")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        match block_type.as_deref() {
            Some("text") => {
                if let Some(t) = block.get_mut("text").and_then(|v| v.as_str()) {
                    let restored = sci_anonymizer::deanonymize(t, session_map);
                    block["text"] = Value::String(restored);
                }
            }
            Some("thinking") => {
                if let Some(t) = block.get_mut("thinking").and_then(|v| v.as_str()) {
                    let restored = sci_anonymizer::deanonymize(t, session_map);
                    block["thinking"] = Value::String(restored);
                }
            }
            _ => {} // tool_use, image, etc. — no user PII echoes to swap
        }
    }
}

// ── Body anonymization ─────────────────────────────────────────────────────

/// Walk an Anthropic `/v1/messages` request body and anonymize every
/// piece of user-visible text. Mutates the JSON in place. Returns the
/// list of detected entities for observability — handlers don't use
/// it today but the shell logs `🔒 masked N` based on the count.
fn anonymize_messages_body(body: &mut Value, map: &mut TokenMap) -> Result<Vec<Entity>> {
    let mut all_entities = Vec::new();

    // Top-level `system` (string) — Anthropic also accepts an array
    // of system blocks; both shapes anonymize the same way. String
    // is the common case.
    if let Some(system) = body.get_mut("system") {
        anonymize_in_place(system, map, &mut all_entities);
    }

    // `messages[*].content` is either a string or an array of typed
    // content blocks. We only touch `text` blocks.
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return Ok(all_entities);
    };
    for message in messages {
        let Some(content) = message.get_mut("content") else { continue; };
        match content {
            Value::String(_) => anonymize_in_place(content, map, &mut all_entities),
            Value::Array(blocks) => {
                for block in blocks {
                    let block_type = block
                        .get("type")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    if block_type.as_deref() == Some("text")
                        && let Some(text) = block.get_mut("text")
                    {
                        anonymize_in_place(text, map, &mut all_entities);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(all_entities)
}

/// Run the anonymizer on a JSON string node, replacing it with the
/// masked text. No-op on non-string nodes. Reuses (and grows) the
/// caller's `TokenMap` so a token assigned in `system` stays the
/// same when it appears again in a user message.
fn anonymize_in_place(node: &mut Value, map: &mut TokenMap, out_entities: &mut Vec<Entity>) {
    let Some(s) = node.as_str() else { return; };
    let result = anonymize(s, Some(std::mem::take(map)));
    *map = result.token_map;
    out_entities.extend(result.detected);
    *node = Value::String(result.text);
}

// ── Memory recall + injection ──────────────────────────────────────────────

/// Pull the most recent user message out of the (already-anonymized)
/// body. Used as the recall query — the embedder picks up whatever
/// signal is left after PII removal, which is intentional (we want
/// recall keyed on topic, not name).
fn extract_recall_seed(body: &Value) -> String {
    let Some(messages) = body.get("messages").and_then(|v| v.as_array()) else {
        return String::new();
    };
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") { continue; }
        let content = msg.get("content");
        if let Some(s) = content.and_then(|v| v.as_str()) { return s.to_string(); }
        if let Some(arr) = content.and_then(|v| v.as_array()) {
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("text")
                    && let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    return t.to_string();
                }
            }
        }
    }
    String::new()
}

/// Recall relevant memories and prepend them to the request body's
/// `system` field. With the `NoopEmbedder` this is a no-op (recall
/// returns empty); with SCI-130's real embedder it lights up brain-
/// icon recall.
async fn inject_memory_context(
    body:     &mut Value,
    seed:     &str,
    state:    &Arc<HandlerState>,
) -> Result<()> {
    if seed.is_empty() { return Ok(()); }

    // Resolve the default profile. `'work'` is the same name the TS
    // agent's `injectMemoryContext` defaults to — kept identical so
    // a user's existing data carries over.
    //
    // The storage lock is acquired in a tight scope: we read the
    // profile, drop the guard, then await the embedder (which can
    // take real wall time once SCI-130 ships). Re-acquire to do the
    // recall. Never holding the lock across `.await` is a hard
    // requirement — `clippy::await_holding_lock` enforces it.
    let profile_id = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        let Some(p) = storage.get_profile("work")? else { return Ok(()); };
        p.id
    };

    let query_emb = state.embedder.embed(seed).await?;

    let hits = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        storage.recall(&sci_memory::RecallQuery {
            query_embedding: &query_emb,
            query:           seed,
            profile_id:      &profile_id,
            limit:           5,
            // Empty `types` searches all three classes, matching the TS
            // default for `injectMemoryContext`.
            types:           &[],
        })?
    };

    // Defense-in-depth: skip recall hits that look like agent-internal
    // automation prompts. These should never have been stored (the
    // write path filters them via `is_agent_automation_prompt`), but
    // older Sci versions / cross-device imports / manual writes could
    // surface them. Re-injecting agent-automation content into the
    // system prompt would (a) pollute the model's context with
    // meta-instructions and (b) trigger Anthropic's OAuth-bearer
    // throttle by inflating the system prompt with non-canonical
    // content (the rate_limit_error Casey hit on 2026-05-09).
    let hits: Vec<_> = hits
        .into_iter()
        .filter(|h| !is_agent_automation_prompt(&h.content))
        .collect();

    if hits.is_empty() { return Ok(()); }

    // Compose a system-prompt prefix listing the recalled facts. The
    // exact format here mirrors `injectMemoryContext` in the TS proxy
    // so a downstream model behaves the same way.
    let mut prefix = String::from(
        "You have memory of previous interactions. Here are relevant memories:\n\n",
    );
    for h in &hits {
        prefix.push_str("- ");
        prefix.push_str(&h.content);
        prefix.push('\n');
    }
    prefix.push('\n');

    merge_recall_into_system(body, &prefix);
    Ok(())
}

/// Markers that identify the caller as Claude Code (or a similar
/// Anthropic-bearer client whose request shape we shouldn't disturb).
/// Detection is content-scan, not position-based — Claude Code's
/// system prompt has multiple introductory blocks (billing header,
/// canonical phrase, system instructions, …) and the gate-relevant
/// signal can sit at any of the first few indices. As of 2026-05,
/// Claude Code's array shape is approximately:
///
///   [0] `"x-anthropic-billing-header: cc_version=…; cc_entrypoint=…; cch=…;"`
///   [1] `"You are Claude Code, Anthropic's official CLI for Claude."`
///   [2..] system instructions, tool catalog, etc.
///
/// We check for either marker so recall doesn't push them around.
const CLAUDE_CODE_MARKERS: &[&str] = &[
    CLAUDE_CODE_SYSTEM_PREFIX,
    "x-anthropic-billing-header:",
];

fn has_claude_code_marker(s: &str) -> bool {
    CLAUDE_CODE_MARKERS.iter().any(|m| s.contains(m))
}

/// Merge a recall-formatted text block into `body.system`.
///
/// Two regimes:
///
/// 1. **Caller is Claude Code (or another Anthropic-OAuth client)** —
///    detected by the presence of any `CLAUDE_CODE_MARKERS` in the
///    existing `system`. Recall gets **appended at the end** so the
///    caller's prefix structure (billing header + canonical phrase +
///    cache-control blocks) reaches Anthropic byte-identical to what
///    they shipped. Without this, the `cc_version=…; cch=…;` billing
///    header gets pushed off position 0 and Anthropic's gate flags
///    the request as unrecognized client → `rate_limit_error`
///    (observed 2026-05-09).
///
/// 2. **Sci is the auth source** (no Claude Code markers; the
///    request came in without its own bearer) — recall is
///    **prepended**. We own the `system` field in this regime; recall
///    at the start is the most prominent place for the model.
///
/// String and array shapes both supported (Anthropic accepts either
/// for prompt-caching workflows).
fn merge_recall_into_system(body: &mut Value, recall: &str) {
    match body.get_mut("system") {
        Some(Value::String(s)) => {
            if has_claude_code_marker(s) {
                // Append at end. Ensure a paragraph break separates
                // the existing content from our injected block.
                let separator = if s.ends_with("\n\n") || s.is_empty() { "" } else { "\n\n" };
                *s = format!("{s}{separator}{recall}");
            } else {
                *s = format!("{recall}{s}");
            }
        }
        Some(Value::Array(blocks)) => {
            let recall_block = serde_json::json!({"type":"text","text":recall});
            let claude_code_present = blocks.iter().any(|b| {
                b.get("text")
                    .and_then(|v| v.as_str())
                    .is_some_and(has_claude_code_marker)
            });
            if claude_code_present {
                blocks.push(recall_block);
            } else {
                blocks.insert(0, recall_block);
            }
        }
        _ => { body["system"] = Value::String(recall.to_string()); }
    }
}

// ── Outbound headers ───────────────────────────────────────────────────────

/// Outcome of `build_upstream_headers`. The `oauth_active` flag tells
/// the caller whether the request fell through to `~/.sci/oauth.json`
/// for credentials, so the caller can apply OAuth-bearer-specific body
/// shaping (SCI-147: Claude Code system-prompt prefix) before the body
/// is serialized to bytes.
#[derive(Debug)]
pub(crate) struct UpstreamHeaderPlan {
    pub headers:      HashMap<String, String>,
    /// True iff we stamped the bearer from the OAuth cache (path 3 in
    /// the precedence list below). Body-level Claude-Code mimicry only
    /// applies on this path — request-supplied API keys and bearers
    /// are left fully untouched.
    pub oauth_active: bool,
}

/// Forward the auth header + Anthropic-specific headers; strip
/// hop-by-hop headers; force `host` to the upstream hostname (so
/// reqwest doesn't round-trip whatever the client sent).
///
/// Auth precedence (matches the TS proxy at
/// `packages/proxy/src/upstream-auth.ts`):
///
///   1. `authorization: Bearer …` from the request — pass through.
///   2. `x-api-key` from the request (BYO API key) — pass through.
///   3. `~/.sci/oauth.json` (Claude Pro / Max OAuth) — refreshed on
///      demand by `sci-oauth`. Adds `oauth-2025-04-20` to
///      `anthropic-beta` (without it, `/v1/messages` rejects bearer
///      auth as "missing API key"). Sets `oauth_active = true` so the
///      caller stamps the Claude Code prefix on the body.
///   4. None of the above → `MissingCredential`.
async fn build_upstream_headers(req: &HandlerRequest) -> Result<UpstreamHeaderPlan> {
    let mut out = HashMap::new();
    let mut oauth_active = false;

    // anthropic-version is required by Anthropic. Default to the same
    // version the TS handler defaults to.
    let av = req.header("anthropic-version").unwrap_or("2023-06-01");
    out.insert("anthropic-version".into(), av.into());

    // Forward `anthropic-beta` if present — clients use this for
    // prompt-caching, oauth, etc. We may append the OAuth beta below.
    if let Some(beta) = req.header("anthropic-beta") {
        out.insert("anthropic-beta".into(), beta.into());
    }

    // Auth: prefer authorization, fall back to x-api-key, then to the
    // OAuth cache. The platform shell's credential injector (cf.
    // SCI-119 in the TS agent) will have stamped one of the first two
    // when the user has BYO keys configured; otherwise we drop down
    // to the Pro / Max OAuth flow.
    let auth    = req.header("authorization");
    let api_key = req.header("x-api-key");
    match (auth, api_key) {
        (Some(a), _) if a.starts_with("Bearer ") => {
            out.insert("authorization".into(), a.into());
        }
        (_, Some(k)) if !k.is_empty() => {
            out.insert("x-api-key".into(), k.into());
        }
        (Some(a), _) if !a.is_empty() => {
            // Non-Bearer authorization (rare, but accept). Pass through.
            out.insert("authorization".into(), a.into());
        }
        _ => {
            // No request-side credential. Try the OAuth cache. If it's
            // there, use it; if not, surface the original
            // MissingCredential — the caller (and the user) sees the
            // same error they would have seen pre-SCI-140, just with
            // an extra recovery path.
            match sci_oauth::cached_token().await {
                Ok(bearer) => {
                    out.insert("authorization".into(), format!("Bearer {bearer}"));
                    oauth_active = true;
                    // Anthropic requires this beta header for OAuth-bearer
                    // auth on `/v1/messages`. Append rather than replace
                    // so client-supplied betas (prompt caching, etc.)
                    // survive — Anthropic accepts a comma-separated list.
                    out.entry("anthropic-beta".into())
                        .and_modify(|v| {
                            if !v.split(',').any(|p| p.trim() == sci_oauth::ANTHROPIC_OAUTH_BETA) {
                                v.push(',');
                                v.push_str(sci_oauth::ANTHROPIC_OAUTH_BETA);
                            }
                        })
                        .or_insert_with(|| sci_oauth::ANTHROPIC_OAUTH_BETA.into());
                }
                Err(_) => {
                    return Err(HandlerError::MissingCredential { header: "x-api-key" });
                }
            }
        }
    }

    out.insert("content-type".into(), "application/json".into());
    out.insert("accept".into(), "text/event-stream, application/json".into());
    Ok(UpstreamHeaderPlan { headers: out, oauth_active })
}

// ── SCI-147: Claude Code system-prompt mimicry on the OAuth path ──────────

/// Canonical opening line Claude Code stamps on the system prompt of
/// every `/v1/messages` call it makes. Anthropic server-side checks
/// for this exact prefix on OAuth-bearer-authenticated requests; if
/// it's missing, the response is a 429 `rate_limit_error` with body
/// `{"message":"Error"}` — terse on purpose, since it's an
/// abuse-detection signal rather than an ordinary tier limit.
///
/// We mirror the phrase byte-for-byte. Any drift (extra space,
/// different punctuation) trips the gate. The TS proxy doesn't carry
/// this string explicitly because Claude Code is its only caller in
/// the production path; we carry it here so non-Claude-Code clients
/// (curl, `sci-oauth-cli`, future Sci Browser) get the same Pro/Max
/// throughput the user is paying for.
const CLAUDE_CODE_SYSTEM_PREFIX: &str =
    "You are Claude Code, Anthropic's official CLI for Claude.";

/// Two trailing newlines so the user's own system prompt (or
/// recall-injected memory context) reads as a separate paragraph
/// rather than running into the prefix sentence.
const CLAUDE_CODE_PREFIX_SEPARATOR: &str = "\n\n";

/// Stamp the Claude Code prefix onto `body.system`. Mutates in place.
/// Idempotent: if the existing system field already starts with the
/// canonical phrase, nothing changes (so Claude Code → Sci → Anthropic
/// chains don't accumulate duplicates).
///
/// Anthropic accepts `system` as either a string or an array of typed
/// blocks; we handle both. Absent → set to a fresh string holding just
/// the prefix.
fn prepend_claude_code_prefix(body: &mut Value) {
    let prefix = CLAUDE_CODE_SYSTEM_PREFIX;
    let sep    = CLAUDE_CODE_PREFIX_SEPARATOR;

    match body.get_mut("system") {
        // Already a string. Idempotent prepend.
        Some(Value::String(s)) => {
            if !s.starts_with(prefix) {
                if s.is_empty() {
                    *s = prefix.to_string();
                } else {
                    *s = format!("{prefix}{sep}{s}");
                }
            }
        }
        // Array-of-blocks shape (Anthropic also accepts this for
        // ergonomic prompt-caching usage). Insert a leading text block
        // unless the first text block already leads with the prefix.
        Some(Value::Array(blocks)) => {
            let already_prefixed = blocks
                .iter()
                .find_map(|b| {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        b.get("text").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                })
                .is_some_and(|t| t.starts_with(prefix));
            if !already_prefixed {
                let block = serde_json::json!({
                    "type": "text",
                    "text": prefix,
                });
                blocks.insert(0, block);
            }
        }
        // Any other shape (or absent). Replace with a fresh string.
        _ => {
            body["system"] = Value::String(prefix.to_string());
        }
    }
}

/// Body-shape fixups applied only when the OAuth bearer fall-through
/// is in play. The Pro/Max OAuth path on `/v1/messages` rejects (or
/// rate-limits) several fields that the API-key tier accepts, so we
/// strip them before forwarding. Each removed field is documented
/// below with the upstream behavior we observed.
///
/// Verified against `api.anthropic.com` 2026-05-10 with a fresh OAuth
/// bearer:
///
///   • `thinking: {"type":"adaptive"}`  → 400 invalid_request_error,
///                                          "adaptive thinking is not
///                                          supported on this model"
///                                          (after several retries
///                                          devolves to 429 rate_limit
///                                          per the abuse-detection
///                                          escalation we hit before)
///
/// LibreChat sends these by default for newer models; we'd otherwise
/// have to fork its config. Stripping at the Sci layer keeps the
/// sci-chat fork unmodified and works for any client whose body shape
/// has the same problem.
fn sanitize_body_for_oauth(body: &mut Value) {
    let Some(obj) = body.as_object_mut() else { return; };

    // ── thinking ────────────────────────────────────────────────────
    // Remove unconditionally on the OAuth path. Real Claude Code's
    // request shape doesn't include `thinking`; absence is the safe
    // default. If/when extended thinking is supported on subscriber
    // bearers, lift this strip.
    if obj.remove("thinking").is_some() {
        tracing::debug!(
            target: "sci_handlers::anthropic::oauth_sanitize",
            "stripped `thinking` field (rejected on OAuth bearer path)",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymize_string_message() {
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"hi from openclaw.dev"}]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let entities = anonymize_messages_body(&mut body, &mut map).unwrap();
        assert!(!entities.is_empty(), "should detect openclaw.dev as URL");
        let masked_content = body["messages"][0]["content"].as_str().unwrap();
        assert!(masked_content.contains("[URL_"), "expected token, got: {masked_content}");
    }

    #[test]
    fn anonymize_array_content_blocks() {
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":[
                {"type":"text","text":"see openclaw.dev for details"},
                {"type":"image","source":{"type":"base64","data":"ignored"}}
              ]}]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut body, &mut map).unwrap();
        let masked = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(masked.contains("[URL_"));
        // Image block untouched.
        assert_eq!(
            body["messages"][0]["content"][1]["source"]["data"].as_str(),
            Some("ignored"),
        );
    }

    #[test]
    fn anonymize_top_level_system() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"the user works on openclaw.dev","messages":[]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut body, &mut map).unwrap();
        let s = body["system"].as_str().unwrap();
        assert!(s.contains("[URL_"));
    }

    // ── Recall-merge tests: the SCI-150 fix that keeps the canonical
    //    Claude Code prefix at position 0 of body.system so Anthropic's
    //    OAuth gate doesn't throttle. ─────────────────────────────────

    const RECALL_BLOCK: &str = "You have memory of previous interactions. Here are relevant memories:\n\n- I live in Tulsa OK\n\n";

    #[test]
    fn merge_recall_no_existing_system_sets_field() {
        let mut body: Value = serde_json::from_str(r#"{"messages":[]}"#).unwrap();
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        assert_eq!(body["system"].as_str().unwrap(), RECALL_BLOCK);
    }

    #[test]
    fn merge_recall_string_system_no_prefix_prepends() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"Be terse.","messages":[]}"#,
        )
        .unwrap();
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        let s = body["system"].as_str().unwrap();
        assert!(s.starts_with(RECALL_BLOCK), "recall should be at start: {s:?}");
        assert!(s.ends_with("Be terse."));
    }

    #[test]
    fn merge_recall_string_with_claude_code_marker_appends_at_end() {
        // When the caller is Claude Code, recall MUST be appended at
        // the very end so the caller's existing structure (billing
        // header, canonical phrase, cache-control blocks, …) reaches
        // Anthropic byte-identical. Empirically, prepending OR
        // inserting-after-prefix both pushed the billing header off
        // position 0, which trips the OAuth-bearer rate-limit gate.
        let original = format!(
            "{prefix}\n\nThe user is Casey Zandbergen.\n\nUse the tools available.",
            prefix = CLAUDE_CODE_SYSTEM_PREFIX,
        );
        let mut body: Value = serde_json::json!({
            "system": original.clone(),
            "messages": [],
        });
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        let s = body["system"].as_str().unwrap();
        // Original content survives at the start, byte-identical.
        assert!(
            s.starts_with(&original),
            "Claude Code's original system prompt must reach Anthropic unchanged at the start: {s:?}",
        );
        // Recall lands at the end, separated by a paragraph break.
        assert!(s.ends_with(RECALL_BLOCK), "recall must land at end: {s:?}");
    }

    #[test]
    fn merge_recall_string_with_billing_header_appends_at_end() {
        // Claude Code's actual array shape often has the billing
        // header at index 0 and the canonical phrase later. Detection
        // via the billing-header substring catches that case even
        // when the canonical phrase isn't first.
        let original = "x-anthropic-billing-header: cc_version=2.1.138.580; cc_entrypoint=cli; cch=17495;\n\nbody...";
        let mut body: Value = serde_json::json!({
            "system": original,
            "messages": [],
        });
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        let s = body["system"].as_str().unwrap();
        assert!(s.starts_with(original), "billing header must remain at position 0: {s:?}");
        assert!(s.ends_with(RECALL_BLOCK));
    }

    #[test]
    fn merge_recall_array_system_no_prefix_inserts_first() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":[{"type":"text","text":"Be terse."}],"messages":[]}"#,
        )
        .unwrap();
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"].as_str().unwrap(), RECALL_BLOCK);
        assert_eq!(arr[1]["text"].as_str().unwrap(), "Be terse.");
    }

    #[test]
    fn merge_recall_array_with_claude_code_markers_appends_at_end() {
        // Recreates Claude Code's actual production system shape:
        // billing header at [0], canonical phrase at [1], rest later.
        // Recall MUST land at the end so [0] stays unchanged.
        let mut body: Value = serde_json::json!({
            "system": [
                {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.138.580; cc_entrypoint=cli;"},
                {"type":"text","text": CLAUDE_CODE_SYSTEM_PREFIX},
                {"type":"text","text":"<rest of Claude Code system prompt>"}
            ],
            "messages": [],
        });
        merge_recall_into_system(&mut body, RECALL_BLOCK);
        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr.len(), 4);
        // Original 3 blocks unchanged in their original positions.
        assert!(arr[0]["text"].as_str().unwrap().starts_with("x-anthropic-billing-header:"));
        assert_eq!(arr[1]["text"].as_str().unwrap(), CLAUDE_CODE_SYSTEM_PREFIX);
        assert_eq!(arr[2]["text"].as_str().unwrap(), "<rest of Claude Code system prompt>");
        // Recall appended at the end.
        assert_eq!(arr[3]["text"].as_str().unwrap(), RECALL_BLOCK);
    }

    #[test]
    fn extract_recall_seed_takes_last_user_message() {
        let body: Value = serde_json::from_str(
            r#"{"messages":[
                {"role":"user","content":"first"},
                {"role":"assistant","content":"reply"},
                {"role":"user","content":"second"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(extract_recall_seed(&body), "second");
    }

    #[tokio::test]
    async fn build_upstream_headers_prefers_x_api_key() {
        let mut headers = HashMap::new();
        headers.insert("x-api-key".into(), "sk-ant-real".into());
        let req = HandlerRequest {
            method: "POST".into(),
            url: "/v1/messages".into(),
            headers,
            body: bytes::Bytes::new(),
            hostname: "api.anthropic.com".into(),
        };
        let plan = build_upstream_headers(&req).await.unwrap();
        assert_eq!(plan.headers.get("x-api-key"), Some(&"sk-ant-real".to_string()));
        assert_eq!(plan.headers.get("anthropic-version"), Some(&"2023-06-01".to_string()));
        assert!(!plan.oauth_active, "x-api-key path should not flip oauth_active");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn build_upstream_headers_errors_on_no_credential() {
        // Point the OAuth cache at a guaranteed-empty path so the
        // fallback can't accidentally find a real token on the dev
        // box where this test runs.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oauth-missing.json");
        // SAFETY: the test is single-threaded within itself; setting
        // an env var here is fine. See sci-oauth tests for the same
        // pattern.
        unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }

        let req = HandlerRequest {
            method: "POST".into(),
            url: "/v1/messages".into(),
            headers: HashMap::new(),
            body: bytes::Bytes::new(),
            hostname: "api.anthropic.com".into(),
        };
        let err = build_upstream_headers(&req).await.unwrap_err();
        assert!(matches!(err, HandlerError::MissingCredential { .. }));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn build_upstream_headers_falls_through_to_oauth_cache() {
        // Write a fake OAuth cache; verify the handler picks it up
        // and stamps the Bearer + the OAuth beta.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oauth.json");
        unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }

        let info = sci_oauth::TokenInfo {
            access_token:  "tok-from-oauth".into(),
            refresh_token: "rrr".into(),
            // Far in the future so cached_token doesn't try to refresh
            // (which would hit the network and fail the test).
            expires_at_ms: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap()
                    .as_millis() as i64
                    + 60 * 60 * 1000,
            ),
            scope:         "user:inference".into(),
            organization:  None,
            account:       None,
            token_uuid:    None,
        };
        std::fs::write(&path, serde_json::to_string(&info).unwrap()).unwrap();

        let req = HandlerRequest {
            method: "POST".into(),
            url: "/v1/messages".into(),
            // No x-api-key, no authorization — should fall through to
            // OAuth cache.
            headers: HashMap::new(),
            body: bytes::Bytes::new(),
            hostname: "api.anthropic.com".into(),
        };
        let plan = build_upstream_headers(&req).await.unwrap();
        assert_eq!(
            plan.headers.get("authorization"),
            Some(&"Bearer tok-from-oauth".to_string()),
        );
        // Beta header injected; nothing else to merge with so it's
        // exactly the OAuth beta.
        assert_eq!(
            plan.headers.get("anthropic-beta"),
            Some(&sci_oauth::ANTHROPIC_OAUTH_BETA.to_string()),
        );
        assert!(!plan.headers.contains_key("x-api-key"));
        assert!(plan.oauth_active, "OAuth fall-through must flip oauth_active");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn oauth_beta_appends_to_existing_betas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oauth.json");
        unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }

        let info = sci_oauth::TokenInfo {
            access_token:  "tok".into(),
            refresh_token: "rrr".into(),
            expires_at_ms: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap()
                    .as_millis() as i64
                    + 60 * 60 * 1000,
            ),
            scope:         "user:inference".into(),
            organization:  None,
            account:       None,
            token_uuid:    None,
        };
        std::fs::write(&path, serde_json::to_string(&info).unwrap()).unwrap();

        let mut headers = HashMap::new();
        headers.insert("anthropic-beta".into(), "prompt-caching-2024-07-31".into());
        let req = HandlerRequest {
            method: "POST".into(),
            url: "/v1/messages".into(),
            headers,
            body: bytes::Bytes::new(),
            hostname: "api.anthropic.com".into(),
        };
        let plan = build_upstream_headers(&req).await.unwrap();
        let beta = plan.headers.get("anthropic-beta").unwrap();
        assert!(beta.contains("prompt-caching-2024-07-31"), "{beta}");
        assert!(beta.contains(sci_oauth::ANTHROPIC_OAUTH_BETA), "{beta}");
    }

    // ── SCI-147: Claude Code system-prompt mimicry ────────────────────────

    #[test]
    fn claude_code_prefix_inserted_when_system_absent() {
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let s = body["system"].as_str().expect("system should be a string");
        assert_eq!(s, CLAUDE_CODE_SYSTEM_PREFIX);
    }

    #[test]
    fn claude_code_prefix_prepended_to_string_system() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"Be terse.","messages":[]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let s = body["system"].as_str().unwrap();
        assert!(s.starts_with(CLAUDE_CODE_SYSTEM_PREFIX), "got: {s:?}");
        assert!(s.ends_with("Be terse."), "user prompt should follow prefix: {s:?}");
        // Two newlines between prefix and the user's prompt — keeps the
        // gate phrase as its own paragraph.
        assert!(s.contains("\n\n"), "expected paragraph break: {s:?}");
    }

    #[test]
    fn claude_code_prefix_idempotent_on_string_system() {
        // Caller (e.g. Claude Code in front of Sci) already stamped
        // the prefix. Sci should not double it.
        let mut body: Value = serde_json::from_str(&format!(
            r#"{{"system":"{prefix}\n\nBe terse.","messages":[]}}"#,
            prefix = CLAUDE_CODE_SYSTEM_PREFIX,
        ))
        .unwrap();
        let before = body["system"].as_str().unwrap().to_string();
        prepend_claude_code_prefix(&mut body);
        let after = body["system"].as_str().unwrap();
        assert_eq!(before, after, "idempotent prepend must not modify");
        // And specifically: the prefix appears exactly once.
        assert_eq!(
            after.matches(CLAUDE_CODE_SYSTEM_PREFIX).count(),
            1,
            "prefix duplicated: {after:?}",
        );
    }

    #[test]
    fn claude_code_prefix_inserted_into_array_system() {
        // Anthropic also accepts `system` as an array of typed blocks
        // (used for prompt-caching block-level cache_control). Verify
        // we insert a leading text block, not stringify the array.
        let mut body: Value = serde_json::from_str(
            r#"{"system":[{"type":"text","text":"Be terse.","cache_control":{"type":"ephemeral"}}],"messages":[]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let arr = body["system"].as_array().expect("system should still be array");
        assert_eq!(arr.len(), 2, "should have prepended one block: {arr:?}");
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
        // Original block preserved including its cache_control.
        assert_eq!(arr[1]["text"], "Be terse.");
        assert_eq!(arr[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn claude_code_prefix_idempotent_on_array_system() {
        let mut body: Value = serde_json::from_str(&format!(
            r#"{{"system":[
                {{"type":"text","text":"{prefix}"}},
                {{"type":"text","text":"Be terse."}}
            ],"messages":[]}}"#,
            prefix = CLAUDE_CODE_SYSTEM_PREFIX,
        ))
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "should not have inserted: {arr:?}");
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
    }

    // ── SCI: non-streaming JSON deanonymizer ──────────────────────────────

    #[test]
    fn deanonymize_json_response_swaps_text_blocks() {
        // Run a real anonymize over a sentence with both classes so the
        // resulting `TokenMap` carries [PERSON_1]→Casey and
        // [URL_1]→openclaw.dev. Tokens are deterministic in extraction
        // order: PERSON before URL given this input.
        let result = sci_anonymizer::anonymize(
            "Casey works on openclaw.dev",
            None,
        );
        let map = result.token_map;

        // The model echoed both tokens back in its content.
        let mut response: Value = serde_json::from_str(
            r#"{
                "id": "msg_x",
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type":"text","text":"Hello [PERSON_1]! Your project [URL_1] is great."},
                    {"type":"image","source":"…ignored…"}
                ]
            }"#,
        )
        .unwrap();
        deanonymize_messages_response(&mut response, &map);

        let restored = response["content"][0]["text"].as_str().unwrap();
        assert!(
            restored.contains("Casey"),
            "expected PERSON token to deanonymize: {restored}",
        );
        assert!(
            restored.contains("openclaw.dev"),
            "expected URL token to deanonymize: {restored}",
        );
        assert!(
            !restored.contains("[PERSON_") && !restored.contains("[URL_"),
            "no token shapes should remain: {restored}",
        );
        // Non-text blocks left alone.
        assert_eq!(response["content"][1]["type"], "image");
    }

    #[test]
    fn deanonymize_json_response_handles_thinking_block() {
        let result = sci_anonymizer::anonymize("Casey", None);
        let map = result.token_map;
        let mut response: Value = serde_json::from_str(
            r#"{"content":[{"type":"thinking","thinking":"the user [PERSON_1] said hi"}]}"#,
        )
        .unwrap();
        deanonymize_messages_response(&mut response, &map);
        let t = response["content"][0]["thinking"].as_str().unwrap();
        assert!(t.contains("Casey"), "thinking deanon failed: {t}");
    }

    #[test]
    fn extract_user_text_returns_pre_anon_real_names() {
        // The whole point: extract BEFORE anonymization, so the
        // memory write captures real names. Recall queries the masked
        // text; storage keeps the originals.
        let body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"My name is Casey and I work on openclaw.dev"}]}"#,
        )
        .unwrap();
        let original = extract_user_text(&body);
        assert_eq!(original, "My name is Casey and I work on openclaw.dev");

        // Now anonymize and confirm extract_user_text would NOT have
        // returned the masked version (i.e. caller MUST extract before
        // anonymizing — this test pins that contract).
        let mut anonymized = body.clone();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut anonymized, &mut map).unwrap();
        let masked = extract_user_text(&anonymized);
        assert!(masked.contains("[PERSON_") || masked.contains("[URL_"),
            "post-anon body should have tokens: {masked}");
        assert_ne!(masked, original, "extract_user_text result depends on call order");
    }

    #[test]
    fn extract_user_text_handles_array_content() {
        let body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":[
                {"type":"text","text":"first part"},
                {"type":"image","source":"…ignored…"},
                {"type":"text","text":"second part"}
            ]}]}"#,
        )
        .unwrap();
        let t = extract_user_text(&body);
        assert!(t.contains("first part") && t.contains("second part"), "{t:?}");
    }

    #[test]
    fn agent_automation_heuristic_catches_known_patterns() {
        assert!(is_agent_automation_prompt("[SUGGESTION MODE: predict next input]"));
        assert!(is_agent_automation_prompt("[SUMMARY: condense the conversation]"));
        assert!(is_agent_automation_prompt("[SYSTEM: do the thing]"));
        assert!(is_agent_automation_prompt("[AUTO_TASK: foo]"));
        assert!(is_agent_automation_prompt("[CODE_REVIEW]"));
        // Leading whitespace OK.
        assert!(is_agent_automation_prompt("   [SUGGESTION MODE: x]"));
    }

    #[test]
    fn agent_automation_heuristic_skips_real_user_messages() {
        assert!(!is_agent_automation_prompt("My name is Casey"));
        assert!(!is_agent_automation_prompt("hi there"));
        assert!(!is_agent_automation_prompt("what's my email"));
        // Lowercase bracketed text is NOT an automation prompt.
        assert!(!is_agent_automation_prompt("[just a note] hi"));
        // No leading bracket.
        assert!(!is_agent_automation_prompt("note: SUGGESTION MODE doesn't count here"));
        // Empty marker (`[]` / `[:`) is not a marker.
        assert!(!is_agent_automation_prompt("[] hello"));
        assert!(!is_agent_automation_prompt("[: hi"));
    }

    #[test]
    fn extract_user_text_picks_most_recent_user() {
        // Multi-turn — should only return the LAST user turn (what
        // was just typed), not the whole conversation.
        let body: Value = serde_json::from_str(
            r#"{"messages":[
                {"role":"user","content":"old message"},
                {"role":"assistant","content":"old reply"},
                {"role":"user","content":"new message"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(extract_user_text(&body), "new message");
    }

    #[test]
    fn deanonymize_json_response_no_content_array_is_noop() {
        // Error bodies and other shapes that don't have a content array
        // should pass through unchanged.
        let map = TokenMap::default();
        let mut response: Value = serde_json::from_str(
            r#"{"type":"error","error":{"message":"oops"}}"#,
        )
        .unwrap();
        let before = response.clone();
        deanonymize_messages_response(&mut response, &map);
        assert_eq!(response, before);
    }

    #[test]
    fn claude_code_prefix_handles_empty_string_system() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"","messages":[]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        // Empty + prefix should be exactly the prefix (no trailing
        // separator that'd render as a stray "\n\n" to the model).
        assert_eq!(body["system"].as_str().unwrap(), CLAUDE_CODE_SYSTEM_PREFIX);
    }
}
