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
    // Wall-clock start for audit_turn.latency_ms. Captured first so it
    // covers parse + anonymize + recall + upstream + deanon.
    let started_at = std::time::Instant::now();

    // ── 0. Safety guards ──────────────────────────────────────────────────
    //
    // Check rate limit BEFORE parsing (cheap) and size cap AFTER trim (after
    // we've done our best to reduce the body). Both fire a 429/413 so
    // LibreChat surfaces an error to the user rather than silently burning
    // tokens.

    if !state.rate_limiter.check_and_record() {
        tracing::error!(
            target: "sci_handlers::rate_limit",
            count = state.rate_limiter.current_count(),
            limit = state.rate_limiter.max_requests,
            window_secs = state.rate_limiter.window_secs,
            "RATE LIMIT: too many requests — blocking to protect token budget"
        );
        let body_stream: BodyStream = Box::pin(futures::stream::once(async {
            Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                b"rate limit: too many requests in 60s - possible retry storm, \
                  check sci-helper logs",
            ))
        }));
        return Ok(HandlerResponse {
            status:               429,
            headers:              std::collections::HashMap::new(),
            body:                 body_stream,
            inspect_request:      None,
            inspect_upstream_raw: None,
        });
    }

    // ── 1. Parse + anonymize ───────────────────────────────────────────────
    let mut body: Value = serde_json::from_slice(&req.body)
        .map_err(|e| HandlerError::Malformed(format!("body JSON: {e}")))?;

    // Tool result truncation: individual tool results (read_file, shell_exec
    // logs, etc.) can be 20–100 KB each and survive whole-message trimming
    // because they're single content blocks. Truncate them first so the
    // subsequent trim and size checks operate on the reduced body.
    let truncated_blocks = truncate_tool_results(&mut body);
    if truncated_blocks > 0 {
        tracing::info!(
            target: "sci_handlers::context",
            count = truncated_blocks,
            max_bytes = MAX_TOOL_RESULT_BYTES,
            "tool result truncation: {} block(s) reduced to ≤{} bytes each",
            truncated_blocks, MAX_TOOL_RESULT_BYTES,
        );
    }

    // Context-window trim: long-running tool-heavy sessions accumulate MB of
    // conversation history. Each 1 MB of body ≈ 250k tokens — expensive and
    // slow. When the serialised body exceeds the threshold, trim the messages
    // array down to a sliding window of the most-recent turns, keeping:
    //   • messages[0]  — LibreChat artifact-instructions (always present)
    //   • last CONTEXT_WINDOW_KEEP turns
    // Sci memory recall injects the relevant long-term context at every turn,
    // so trimming the raw message history is safe.
    trim_context_window(&mut body, req.body.len());

    // Prompt-cache markers — added BEFORE size estimation so the
    // size check sees the final body shape.
    mark_cache_control(&mut body);

    // Hard size cap: if the body is STILL too large after trimming, block the
    // request entirely. This should never fire in normal operation (trim keeps
    // bodies to ~50–150 KB) but acts as a final backstop against pathological
    // cases — extremely long individual messages, code dumps, etc.
    const HARD_MAX_BODY_BYTES: usize = 800_000; // ~200k tokens absolute max
    let trimmed_size = serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(req.body.len());
    if trimmed_size > HARD_MAX_BODY_BYTES {
        tracing::error!(
            target: "sci_handlers::size_guard",
            bytes = trimmed_size,
            limit = HARD_MAX_BODY_BYTES,
            "HARD SIZE CAP: request body still too large after trim — blocking"
        );
        let body_stream: BodyStream = Box::pin(futures::stream::once(async {
            Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                b"request too large: context exceeds hard limit even after trimming. \
                  Start a new conversation to reset context.",
            ))
        }));
        return Ok(HandlerResponse {
            status:               413,
            headers:              std::collections::HashMap::new(),
            body:                 body_stream,
            inspect_request:      None,
            inspect_upstream_raw: None,
        });
    }

    // Capture the original (pre-anonymization) user text BEFORE we mask
    // the body — that's what we'll store to memory after the request
    // completes. The TS proxy at packages/proxy/src/middleware/memory.ts
    // does the same: storage gets the real names, anonymization only
    // affects what leaves the machine. Mirroring that contract is what
    // makes "your memory follows you across devices" actually work.
    let original_user_text = extract_user_text(&body);

    // Model name for the audit_turn row (not PII, lives in the body
    // pre-anon — anonymization wouldn't touch it anyway since model
    // names are not entities, but capturing here keeps the read path
    // close to where the source-of-truth body lives).
    let model_name = body
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    // Snapshot the messages array once, before anonymization. Both the
    // per-request circuit breaker and the cross-turn cascade breaker
    // use this same snapshot for rollback — no double clone.
    let messages_snapshot = body
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::Value::Array(vec![]));

    let mut session_map = TokenMap::default();
    let entities        = anonymize_messages_body(&mut body, &mut session_map)?;
    let masked_count    = entities.len() as u32;

    // Cross-turn cascade breaker: update the monitor and fire if 5 or more
    // consecutive turns have all exceeded the elevated-entity threshold.
    // Uses the same rollback path as the per-request breaker.
    let profile_id = state.active_profile_name();
    if masked_count > 0 {
        // Only feed real counts. When the per-request breaker already fired
        // (masked_count == 0), we pass 0 so the window absorbs a "clean"
        // turn rather than inflating the cascade signal.
        let cascade = state
            .cascade_monitor
            .update_and_check(masked_count, &profile_id);

        if cascade {
            tracing::error!(
                target: "sci_handlers::anonymizer",
                masked_count,
                profile = %profile_id,
                "ANONYMIZER CASCADE DETECTED: 5 consecutive turns above elevated \
                 threshold. Rolling back substitutions and resetting monitor. \
                 Check NER rules for a feedback loop in conversation history."
            );
            if let Some(msgs) = body.get_mut("messages") {
                *msgs = messages_snapshot;
            }
            session_map = TokenMap::default();
            let err_body: BodyStream = Box::pin(futures::stream::once(async {
                Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                    b"anonymizer cascade detected; request rolled back \
                      \x97 check sci-helper logs",
                ))
            }));
            return Ok(HandlerResponse {
                status:               503,
                headers:              std::collections::HashMap::new(),
                body:                 err_body,
                inspect_request:      None,
                inspect_upstream_raw: None,
            });
        }
    } else {
        // Per-request breaker already fired; register a zero so the cascade
        // window doesn't count this turn as elevated.
        state.cascade_monitor.update_and_check(0, &profile_id);
    }

    // SCI-200: orphan `tool_use` guard. Upstream chat harnesses
    // (LibreChat agents, openclaw, custom Langchain clients) sometimes
    // persist an assistant `tool_use` whose matching `tool_result` was
    // never written — agent died mid-call, streaming corruption ate the
    // tool_result, anonymizer truncation, whatever. Anthropic's
    // /v1/messages then 400's the whole request with
    // `tool_use ids were found without tool_result blocks immediately
    // after`. The conversation becomes permanently stuck because every
    // resend re-submits the same broken history.
    //
    // Repair-on-the-wire: scan messages, inject a synthetic
    // `is_error: true` tool_result for each orphan so Anthropic accepts
    // the request. Each repair is logged so we can spot upstream bugs.
    let orphan_repaired = repair_orphan_tool_uses(&mut body);
    if orphan_repaired > 0 {
        tracing::warn!(
            target: "sci_handlers::anthropic",
            repaired = orphan_repaired,
            "SCI-200 auto-repaired {orphan_repaired} orphan tool_use block(s) in outbound request"
        );
    }

    // SCI-200b: orphan `server_tool_use` guard (Anthropic native web_search).
    //
    // Anthropic's native web_search beta emits a `server_tool_use` block
    // (id: "srvtoolu_…") AND a `web_search_tool_result` block in the SAME
    // assistant turn. LibreChat's @librechat/agents skips the
    // `web_search_tool_result` chunk when building stored contentParts
    // (handleServerToolResult returns skipHandling=true), so the result block
    // is never persisted. On replay, LangChain emits the assistant message
    // with `server_tool_use` but without `web_search_tool_result`, and the
    // Anthropic API rejects with:
    //   "messages.N: `web_search` tool use … found without a corresponding
    //    `web_search_tool_result` block"
    //
    // Fix: inject a `web_search_tool_result_error` block immediately after
    // each orphaned `server_tool_use` in the assistant message, and strip any
    // stale `tool_result` for the same srvtoolu_ ID from the next user message
    // (LangChain sometimes emits these when the provider hint is absent).
    let srv_repaired = repair_orphan_server_tool_uses(&mut body);
    if srv_repaired > 0 {
        tracing::warn!(
            target: "sci_handlers::anthropic",
            repaired = srv_repaired,
            "SCI-200b auto-repaired {srv_repaired} orphan server_tool_use block(s) in outbound request"
        );
    }

    // ── 2. Memory recall + injection ───────────────────────────────────────
    //
    // Pull the user's most recent text out of `messages[].content` and
    // use it to recall relevant memories. With `NoopEmbedder` this
    // returns an empty list (zero-vector cosine). When SCI-130 ships
    // BgeEmbedder, the same code path lights up brain-icon recall.
    let recall_seed = extract_recall_seed(&body);
    let _ = inject_memory_context(&mut body, &recall_seed, &state).await;

    // SCI-159: Project Mode. If the user has set an active project
    // working directory, inject a "Working directory: <path>" hint
    // into the system prompt so the model defaults filesystem-tool
    // paths to it and accepts relative path references. No-op when
    // active_project is None.
    inject_project_context(&mut body, &state);

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

    // SCI-130 / flight-recorder storage hook. Both the streaming and
    // non-streaming paths feed the same `spawn_record_turn` once the
    // assistant's text is in hand:
    //
    //   - SSE: register a finalize callback on `DeanonymizingStream`
    //     that fires after the upstream stream ends. The callback
    //     receives the fully deanonymized assistant text already
    //     accumulated by the deanonymizer, plus an optional raw-
    //     bytes snapshot the deanonymizer captured for response_raw.
    //   - JSON: `deanonymize_json_body` extracts the assistant text
    //     synchronously after deanon completes and we hand all the
    //     artifacts to spawn_record_turn directly.
    //
    // `spawn_record_turn` writes two artifacts on every successful
    // turn: (1) episodic memory rows for both halves of the turn so
    // recall surfaces stable assistant claims, and (2) a single
    // audit_turns row + token_mappings for the flight recorder.
    //
    // Snapshot the bits we need from session_map BEFORE moving it into
    // the deanonymizer. Token-mapping records are derived from the
    // `entities` list paired with the session_map.forward lookup at
    // this exact point; once the map moves, both go with it.
    let token_mapping_snapshot = build_token_mapping_snapshot(&entities, &session_map);
    let request_body_snapshot  = String::from_utf8_lossy(
        inspect_request.as_deref().unwrap_or(&[]),
    ).into_owned();

    let (body_stream, inspect_upstream_raw): (BodyStream, Option<bytes::Bytes>) = if is_sse {
        let state_for_finalize = state.clone();
        let user_text_for_finalize = original_user_text.clone();
        let model_for_finalize = model_name.clone();
        let host_for_finalize = req.hostname.clone();
        let endpoint_for_finalize = req.url.clone();
        let token_mapping_for_finalize = token_mapping_snapshot.clone();
        let request_body_for_finalize = request_body_snapshot.clone();
        let upstream_status = upstream_resp.status;
        let deanon  = DeanonymizingStream::new();
        let metrics_arc = deanon.cache_metrics.clone();
        let stream = deanon.wrap_with_finalize(
            upstream_resp.body,
            session_map,
            move |assistant_text| {
                let cache = metrics_arc.lock().ok().and_then(|g| g.clone());
                spawn_record_turn(RecordTurnInput {
                    state:           state_for_finalize,
                    user_text:       user_text_for_finalize,
                    assistant_text,
                    model:           model_for_finalize,
                    host:            host_for_finalize,
                    endpoint:        endpoint_for_finalize,
                    oauth_active,
                    masked_count,
                    request_body:    request_body_for_finalize,
                    response_raw:    None,
                    status:          upstream_status,
                    latency_ms:      started_at.elapsed().as_millis() as u64,
                    token_mappings:  token_mapping_for_finalize,
                    cache_creation_tokens: cache.as_ref().map(|m| m.cache_creation_tokens),
                    cache_read_tokens:     cache.as_ref().map(|m| m.cache_read_tokens),
                    input_tokens:          cache.as_ref().map(|m| m.input_tokens),
                    output_tokens:         cache.as_ref().map(|m| m.output_tokens),
                });
            },
        );
        (stream, None)
    } else {
        // JSON: `deanonymize_json_body` already buffers the full
        // upstream body before deanon — return that buffer too so
        // the platform shell can emit it as an inspector event,
        // plus the extracted deanonymized assistant text for the
        // flight recorder.
        let (stream, raw, assistant_text) =
            deanonymize_json_body(upstream_resp.body, session_map).await?;
        spawn_record_turn(RecordTurnInput {
            state:           state.clone(),
            user_text:       original_user_text.clone(),
            assistant_text,
            model:           model_name.clone(),
            host:            req.hostname.clone(),
            endpoint:        req.url.clone(),
            oauth_active,
            masked_count,
            request_body:    request_body_snapshot,
            response_raw:    Some(String::from_utf8_lossy(&raw).into_owned()),
            status:          upstream_resp.status,
            latency_ms:      started_at.elapsed().as_millis() as u64,
            token_mappings:  token_mapping_snapshot,
            // JSON path: parse usage directly from response body.
            cache_creation_tokens: None,
            cache_read_tokens:     None,
            input_tokens:          None,
            output_tokens:         None,
        });
        (stream, Some(raw))
    };

    let mut headers = upstream_resp.headers;
    // SCI-138 — masked count surfaced as an internal header. The
    // platform shell reads it for telemetry, then strips it before
    // forwarding to the actual client.
    headers.insert("x-sci-masked".into(), masked_count.to_string());

    Ok(HandlerResponse {
        status:  upstream_resp.status,
        headers,
        body:    body_stream,
        inspect_request,
        inspect_upstream_raw,
    })
}

/// SCI-200: outbound-request guard against orphan `tool_use` blocks.
///
/// Anthropic's `/v1/messages` rejects (400 `invalid_request_error`) any
/// request where an assistant message contains a `tool_use` content
/// block whose `id` has no matching `tool_result` block in the very next
/// user message. Upstream chat harnesses produce orphans when an agent
/// run truncates mid-tool-call: the assistant turn persists a `tool_use`
/// to history, then the harness dies before the matching result lands.
/// Every subsequent send re-submits the orphaned history and 400's
/// forever — the conversation becomes permanently un-stuck without
/// surgery on the upstream message store.
///
/// This pass scans the outbound `messages` array and injects a synthetic
/// `tool_result` with `is_error: true` for each orphan, so Anthropic
/// accepts the request. The synthetic body says explicitly that the
/// tool call was interrupted, giving the model a chance to recover the
/// conversation gracefully instead of pretending the call succeeded.
///
/// Returns the count of synthetic results injected. `0` in the happy
/// path (every `tool_use` already has a matching `tool_result`).
fn repair_orphan_tool_uses(body: &mut Value) -> u32 {
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return 0;
    };

    // First pass (read-only): collect orphan ids per assistant message.
    // We can't mutate while iterating, so we record (target_index,
    // orphan_ids, needs_new_user_message) and apply in reverse-index
    // order below.
    let mut planned: Vec<(usize, Vec<String>, bool)> = Vec::new();

    for i in 0..messages.len() {
        let role = messages[i].get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" { continue; }
        let Some(content) = messages[i].get("content").and_then(|v| v.as_array()) else {
            // `content` is a plain string (text-only assistant turn) — no
            // tool_use blocks possible, skip.
            continue;
        };

        let tool_use_ids: Vec<String> = content.iter()
            .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        if tool_use_ids.is_empty() { continue; }

        let next_idx = i + 1;
        let next_is_user = next_idx < messages.len()
            && messages[next_idx].get("role").and_then(|v| v.as_str()) == Some("user");

        let existing_result_ids: std::collections::HashSet<String> = if next_is_user {
            messages[next_idx].get("content").and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
                    .filter_map(|c| c.get("tool_use_id").and_then(|v| v.as_str()).map(String::from))
                    .collect())
                .unwrap_or_default()
        } else {
            std::collections::HashSet::new()
        };

        let orphans: Vec<String> = tool_use_ids.into_iter()
            .filter(|id| !existing_result_ids.contains(id))
            .collect();
        if orphans.is_empty() { continue; }

        // target_idx for application: existing user message → its index;
        // missing user message → the assistant's own index (we'll insert
        // a new user message at assistant_idx + 1).
        let target_idx = if next_is_user { next_idx } else { i };
        planned.push((target_idx, orphans, !next_is_user));
    }

    let total_injected: u32 = planned.iter().map(|(_, ids, _)| ids.len() as u32).sum();
    if total_injected == 0 { return 0; }

    // Apply in reverse so insertions of new messages don't shift the
    // indices of earlier-recorded targets.
    planned.sort_by(|a, b| b.0.cmp(&a.0));
    for (target_idx, orphan_ids, needs_new_message) in planned {
        for id in &orphan_ids {
            tracing::warn!(
                target: "sci_handlers::anthropic",
                tool_use_id = id.as_str(),
                "orphan tool_use auto-repaired (SCI-200): upstream sent assistant tool_use without matching tool_result; injecting synthetic is_error tool_result so /v1/messages does not 400"
            );
        }
        let synthetic_blocks: Vec<Value> = orphan_ids.iter().map(|id| {
            serde_json::json!({
                "type":         "tool_result",
                "tool_use_id":  id,
                "content":      "[orphan tool_use auto-repaired by sci-helper (SCI-200): no tool_result was persisted upstream; treat as a non-event and continue]",
                "is_error":     true,
            })
        }).collect();

        if needs_new_message {
            // No user message follows the assistant — insert one.
            let new_msg = serde_json::json!({
                "role":    "user",
                "content": synthetic_blocks,
            });
            messages.insert(target_idx + 1, new_msg);
        } else {
            // Prepend synthetic results into the existing user message's
            // content array. Order doesn't matter for the API, but
            // grouping tool_results at the start mirrors what well-formed
            // clients do and keeps the array shape predictable.
            let content = messages[target_idx].get_mut("content")
                .expect("checked above")
                .as_array_mut()
                .expect("checked above");
            for block in synthetic_blocks.into_iter().rev() {
                content.insert(0, block);
            }
        }
    }

    total_injected
}

/// SCI-200b: repair orphaned `server_tool_use` blocks (Anthropic native web_search).
///
/// For Anthropic's native `web_search` tool, both the `server_tool_use` block
/// (the search request) and the `web_search_tool_result` block (the results)
/// appear in the SAME assistant message. LibreChat's @librechat/agents does not
/// persist the `web_search_tool_result` block, so replayed conversation history
/// contains `server_tool_use` without its paired result. Anthropic's API rejects
/// this with a 400: "web_search tool use … found without a corresponding
/// web_search_tool_result block".
///
/// Additionally, LangChain sometimes emits a stale `tool_result` block for the
/// same `srvtoolu_` ID in the following user message (when formatAgentMessages
/// is called without a provider hint). These stale `tool_result` blocks are also
/// stripped to prevent secondary orphan errors.
///
/// Returns the number of `web_search_tool_result_error` blocks injected.
fn repair_orphan_server_tool_uses(body: &mut Value) -> u32 {
    const SRV_PREFIX: &str = "srvtoolu_";

    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return 0;
    };

    // First pass (read-only): for each assistant message, find server_tool_use
    // ids that have no matching web_search_tool_result in the same message.
    // Record (assistant_idx, [orphan_ids]) for the mutation pass.
    let mut planned: Vec<(usize, Vec<String>)> = Vec::new();

    for i in 0..messages.len() {
        let role = messages[i].get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" { continue; }

        let Some(content) = messages[i].get("content").and_then(|v| v.as_array()) else {
            continue;
        };

        // Collect srvtoolu_ ids from server_tool_use (or tool_use with srvtoolu_ id).
        let server_tool_use_ids: Vec<String> = content.iter()
            .filter(|c| {
                let t = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                (t == "server_tool_use" || t == "tool_use")
                    && c.get("id").and_then(|v| v.as_str())
                        .map(|id| id.starts_with(SRV_PREFIX))
                        .unwrap_or(false)
            })
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();

        if server_tool_use_ids.is_empty() { continue; }

        // Collect web_search_tool_result tool_use_ids already in this message.
        let existing_result_ids: std::collections::HashSet<String> = content.iter()
            .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some("web_search_tool_result"))
            .filter_map(|c| c.get("tool_use_id").and_then(|v| v.as_str()).map(String::from))
            .collect();

        let orphans: Vec<String> = server_tool_use_ids.into_iter()
            .filter(|id| !existing_result_ids.contains(id))
            .collect();

        if !orphans.is_empty() {
            planned.push((i, orphans));
        }
    }

    let total_injected: u32 = planned.iter().map(|(_, ids)| ids.len() as u32).sum();
    if total_injected == 0 { return 0; }

    // Collect all repaired srvtoolu_ ids for the user-message cleanup pass.
    let repaired_ids: std::collections::HashSet<String> = planned.iter()
        .flat_map(|(_, ids)| ids.iter().cloned())
        .collect();

    // Apply mutations in reverse index order to preserve indices.
    // Insert web_search_tool_result_error blocks AFTER each orphaned server_tool_use.
    planned.sort_by(|a, b| b.0.cmp(&a.0));
    for (assistant_idx, orphan_ids) in planned {
        for id in &orphan_ids {
            tracing::warn!(
                target: "sci_handlers::anthropic",
                tool_use_id = id.as_str(),
                "orphan server_tool_use auto-repaired (SCI-200b): upstream sent server_tool_use \
                 without web_search_tool_result; injecting synthetic error block"
            );
        }

        let content = messages[assistant_idx]
            .get_mut("content")
            .and_then(|v| v.as_array_mut())
            .expect("content was an array above");

        // For each orphan, insert the error block immediately after the server_tool_use.
        // Traverse in reverse so earlier insertions don't shift later indices.
        let orphan_set: std::collections::HashSet<&str> =
            orphan_ids.iter().map(String::as_str).collect();
        let positions: Vec<usize> = content.iter().enumerate()
            .filter(|(_, c)| {
                let t = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                (t == "server_tool_use" || t == "tool_use")
                    && c.get("id").and_then(|v| v.as_str())
                        .map(|id| orphan_set.contains(id))
                        .unwrap_or(false)
            })
            .map(|(idx, _)| idx)
            .collect();

        for (offset, pos) in positions.into_iter().enumerate() {
            let insert_after = pos + 1 + offset; // adjust for prior insertions
            let id = content[insert_after - 1]
                .get("id").and_then(|v| v.as_str())
                .unwrap_or("").to_string();
            let error_block = serde_json::json!({
                "type": "web_search_tool_result",
                "tool_use_id": id,
                "content": {
                    "type": "web_search_tool_result_error",
                    "error_code": "unavailable"
                }
            });
            content.insert(insert_after, error_block);
        }
    }

    // Strip stale tool_result blocks with srvtoolu_ ids from user messages.
    // These are produced by LangChain when it doesn't know the provider is
    // Anthropic and formats server-tool results as regular tool_results.
    let messages = body.get_mut("messages").and_then(|v| v.as_array_mut())
        .expect("messages was checked above");
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") { continue; }
        let Some(content) = msg.get_mut("content").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        content.retain(|block| {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                return true;
            }
            let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
            !repaired_ids.contains(tool_use_id)
        });
        // If the user message content is now empty, replace with a placeholder
        // text block so role-alternation stays intact.
        if content.is_empty() {
            content.push(serde_json::json!({"type": "text", "text": ""}));
        }
    }

    total_injected
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

        // String content — skip if it's boilerplate (artifact instructions etc.)
        if let Some(s) = content.and_then(|v| v.as_str()) {
            if !is_agent_automation_prompt(s) {
                return s.to_string();
            }
            continue;
        }

        if let Some(arr) = content.and_then(|v| v.as_array()) {
            // Skip messages that are entirely tool_result blocks — those are
            // tool outputs from prior turns, not user-authored text.
            let has_only_tool_results = arr.iter().all(|b| {
                b.get("type").and_then(|v| v.as_str()) == Some("tool_result")
            });
            if has_only_tool_results { continue; }

            // Concatenate text blocks, skipping boilerplate chunks.
            let parts: Vec<&str> = arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        b.get("text").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                })
                .filter(|s| !is_agent_automation_prompt(s))
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
/// short questions like `"what's my email"` (15 chars). Set to 20 —
/// skips single-word pings ("hi", "ok", "yes", "you back?") that
/// pollute recall without adding signal, while keeping real questions.
const STORE_MIN_CHARS: usize = 20;

/// SCI-156: profile name fallback if `state.active_profile_name()`
/// returns something we can't resolve. Matches the TS proxy's
/// hard-coded `'work'` so behavior on a fresh DB is unchanged.
const DEFAULT_STORE_PROFILE: &str = "work";

/// True if `s` looks like an agent's internal automation prompt
/// rather than a real user turn. Three families of patterns:
///
///   1. **Bracket markers** — `[SUGGESTION MODE: ...]`,
///      `[SUMMARY: ...]`, `[SYSTEM: ...]`. Original Claude Code-shape.
///
///   2. **XML/HTML-like opening tags** — `<system-reminder>`,
///      `<task>`, `<conversation>`. Claude Code uses these as
///      conversation control envelopes; they get sent as user-role
///      content but are pure metadata. Casey's DB had 14 KB blobs of
///      `<system-reminder>The following deferred tools are now
///      available …` getting stored as if they were user input.
///
///   3. **Known agent-prompt prefixes** — LibreChat fires "Provide a
///      concise, 5-word-or-less title for the conversation …" after
///      every chat to auto-name conversations, and "The user stepped
///      away and is coming back. Recap …" on session-resume. These
///      are imperative instructions TO the model phrased about the
///      conversation in third person — never how a real user talks
///      about themselves.
///
/// False positives (a user prompt that happens to begin `[BUG REPORT:`
/// or `<note>` or `Provide a step-by-step …`) are accepted: worst case
/// is one prompt not remembered. Better than letting a 14 KB
/// system-reminder blob clog recall.
fn is_agent_automation_prompt(s: &str) -> bool {
    let trimmed = s.trim_start();

    // Family 1: `[CAPS_MARKER:` or `[CAPS_MARKER]`.
    if trimmed.starts_with('[') {
        let after_bracket = &trimmed[1..];
        let end = after_bracket
            .find([':', ']'])
            .unwrap_or(after_bracket.len().min(64));
        if end > 0 {
            let marker = &after_bracket[..end];
            let has_upper = marker.chars().any(|c| c.is_ascii_uppercase());
            let only_marker_chars = marker
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == ' ' || c == '_');
            if has_upper && only_marker_chars {
                return true;
            }
        }
    }

    // Family 2: `<lowercase-or-snake-case-tag>` at start. Real users
    // don't open messages with HTML/XML tags; agents use them as
    // metadata envelopes.
    if trimmed.starts_with('<') {
        // Match `<[a-z][a-z0-9_-]*>` — same shape Claude Code uses.
        let after_lt = &trimmed[1..];
        if let Some(end) = after_lt.find('>')
            && end > 0
            && end < 32  // bound runaway
        {
            let tag = &after_lt[..end];
            let well_formed = tag
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
                && tag.starts_with(|c: char| c.is_ascii_lowercase());
            if well_formed && !tag.is_empty() {
                return true;
            }
        }
    }

    // Family 3: known LibreChat / agent imperative-instruction
    // prefixes. Each one is a stable phrasing — they don't
    // paraphrase between requests.
    const KNOWN_AGENT_PREFIXES: &[&str] = &[
        "Provide a concise, 5-word-or-less title for",
        "Provide a concise title for",
        "Generate a title for the conversation",
        "The user stepped away and is coming back",
        "Recap in under ",
        "Summarize the following conversation",
        // LibreChat artifact system prompt — sent as messages[0] with role=user
        // in every request. Not user PII; storing it pollutes recall with
        // documentation blobs about artifact creation.
        "The assistant can create and reference artifacts during conversations",
    ];
    for p in KNOWN_AGENT_PREFIXES {
        if trimmed.starts_with(p) {
            return true;
        }
    }

    false
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

/// Snapshot of the (token, original, kind) tuples for one request,
/// derived at the point where both `entities` and `session_map` are
/// still owned by the handler. Owned strings (not borrows) so the
/// snapshot can survive being moved into the post-stream finalize
/// callback or a tokio::spawn.
#[derive(Clone, Debug)]
struct TokenMappingSnap {
    pub token:       String,
    pub original:    String,
    pub entity_kind: String,
}

/// Build the per-request token-mapping snapshot for audit_turns. Walks
/// the detected entities, looks up each one's assigned token in the
/// forward map, and emits a (token, original, kind) tuple. De-dupes
/// by (token, original) — a single entity that appears in both `system`
/// and `messages[*]` should only show up once in token_mappings.
fn build_token_mapping_snapshot(
    entities:    &[Entity],
    session_map: &TokenMap,
) -> Vec<TokenMappingSnap> {
    let mut seen: std::collections::HashSet<(String, String)> = Default::default();
    let mut out  = Vec::with_capacity(entities.len());
    for e in entities {
        let Some(token) = session_map.forward.get(&e.text) else {
            // Anonymizer found an entity but no mapping landed —
            // shouldn't happen with current implementation, but skip
            // rather than panic if it ever does.
            continue;
        };
        let key = (token.clone(), e.text.clone());
        if !seen.insert(key) {
            continue;
        }
        out.push(TokenMappingSnap {
            token:       token.clone(),
            original:    e.text.clone(),
            entity_kind: e.entity_type.token_prefix().to_owned(),
        });
    }
    out
}

/// Inputs to `spawn_record_turn`. Grouped into a struct so the call
/// site (which hits this from two places) doesn't drift on positional
/// arguments — and so future fields (recall_injected, error string,
/// profile_id) can land without ripple.
struct RecordTurnInput {
    state:          Arc<HandlerState>,
    user_text:      String,
    assistant_text: String,
    model:          Option<String>,
    host:           String,
    endpoint:       String,
    oauth_active:   bool,
    masked_count:   u32,
    request_body:   String,
    response_raw:   Option<String>,
    status:         u16,
    latency_ms:     u64,
    token_mappings: Vec<TokenMappingSnap>,
    /// Prompt-cache metrics from Anthropic's message_start SSE event.
    cache_creation_tokens: Option<u64>,
    cache_read_tokens:     Option<u64>,
    input_tokens:          Option<u64>,
    output_tokens:         Option<u64>,
}

/// Spawn a background task that does two writes for every successful
/// turn:
///
///   1. **Episodic memory rows** — both halves of the turn (user
///      prompt + assistant response) get embedded + stored so future
///      recall surfaces stable assistant claims, not just user
///      questions.
///   2. **Audit turn row + token mappings** — flight-recorder log
///      capturing the full request/response artifacts, masked count,
///      latency, OAuth-path flag, and per-entity token mappings.
///
/// Non-blocking: errors are swallowed at debug level. Failing to
/// remember an interaction is a soft failure, not worth surfacing to
/// the model client. The user-text gating
/// (`is_agent_automation_prompt`, `looks_like_slash_command_output`,
/// length floor) decides whether to record the EPISODIC memory; the
/// audit_turn always lands so the inspector panel shows even
/// internal-title-generation traffic — that's exactly the kind of
/// thing we want visible in the flight recorder.
fn spawn_record_turn(input: RecordTurnInput) {
    tokio::spawn(async move {
        let RecordTurnInput {
            state,
            user_text,
            assistant_text,
            model,
            host,
            endpoint,
            oauth_active,
            masked_count,
            request_body,
            response_raw,
            status,
            latency_ms,
            token_mappings,
            cache_creation_tokens,
            cache_read_tokens,
            input_tokens,
            output_tokens,
        } = input;

        // Group both sides under one timestamp so a future audit_turns
        // join can pair them via metadata.turn_group. Cheap.
        let turn_group = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            .to_string();

        // ── Episodic memory writes (filtered) ─────────────────────────────
        let user_trimmed = user_text.trim();
        let store_user = user_trimmed.chars().count() >= STORE_MIN_CHARS
            && !is_agent_automation_prompt(user_trimmed)
            && !looks_like_slash_command_output(user_trimmed);
        if store_user {
            if let Err(e) = store_interaction(&state, &user_text, "user", &turn_group).await {
                tracing::debug!(error = %e, role = "user", "memory write failed (non-fatal)");
            }
            let asst_trimmed = assistant_text.trim();
            if asst_trimmed.chars().count() >= STORE_MIN_CHARS
                && let Err(e) = store_interaction(&state, &assistant_text, "assistant", &turn_group).await
            {
                tracing::debug!(error = %e, role = "assistant", "memory write failed (non-fatal)");
            }
        } else if user_trimmed.chars().count() >= STORE_MIN_CHARS {
            // Skipped because of the agent-automation / slash-command
            // filter — log so the audit_turn dashboard can pair "I see
            // a turn but no episodic memory for it" with a reason.
            tracing::debug!(
                preview = &user_trimmed[..user_trimmed.len().min(60)],
                "skipping memory write: looks like agent automation or slash command",
            );
        }

        // ── Audit turn row (always lands) ─────────────────────────────────
        if let Err(e) = record_audit_turn(
            &state,
            &user_text,
            &assistant_text,
            model.as_deref(),
            &host,
            &endpoint,
            oauth_active,
            masked_count,
            &request_body,
            response_raw.as_deref(),
            status,
            latency_ms,
            &token_mappings,
            cache_creation_tokens,
            cache_read_tokens,
            input_tokens,
            output_tokens,
        ).await {
            tracing::debug!(error = %e, "audit_turn write failed (non-fatal)");
        }
    });
}

/// Resolve the default profile + persist one audit_turns row plus all
/// associated token_mappings. Called fire-and-forget from
/// `spawn_record_turn`. Async only because we want to drop the storage
/// lock before any potential await; the actual SQLite write is sync.
async fn record_audit_turn(
    state:                 &Arc<HandlerState>,
    user_text:             &str,
    assistant_text:        &str,
    model:                 Option<&str>,
    host:                  &str,
    endpoint:              &str,
    oauth_active:          bool,
    masked_count:          u32,
    request_body:          &str,
    response_raw:          Option<&str>,
    status:                u16,
    latency_ms:            u64,
    token_mappings:        &[TokenMappingSnap],
    cache_creation_tokens: Option<u64>,
    cache_read_tokens:     Option<u64>,
    input_tokens:          Option<u64>,
    output_tokens:         Option<u64>,
) -> Result<()> {
    let profile_name = state.active_profile_name();
    let profile_id = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        // Fall through from the requested profile to "work" so a
        // bad active-profile setting doesn't silently lose audit
        // rows. If both are missing, we just don't write the audit
        // turn (same behavior as before this change).
        let by_active = storage.get_profile(&profile_name)?;
        let resolved  = if by_active.is_some() {
            by_active
        } else {
            storage.get_profile(DEFAULT_STORE_PROFILE)?
        };
        resolved.map(|p| p.id)
    };

    let mappings: Vec<sci_memory::TokenMappingInput<'_>> = token_mappings
        .iter()
        .map(|m| sci_memory::TokenMappingInput {
            token:       &m.token,
            original:    &m.original,
            entity_kind: &m.entity_kind,
            direction:   sci_memory::TokenDirection::Outbound,
        })
        .collect();

    let user_text_opt      = (!user_text.is_empty()).then_some(user_text);
    let assistant_text_opt = (!assistant_text.is_empty()).then_some(assistant_text);

    let storage = state.storage.lock()
        .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
    storage.store_audit_turn(&sci_memory::StoreAuditTurnInput {
        profile_id:      profile_id.as_deref(),
        host,
        endpoint,
        model,
        oauth_active,
        user_text:       user_text_opt,
        assistant_text:  assistant_text_opt,
        request_body:    Some(request_body),
        response_raw,
        recall_injected: None,
        masked_count,
        status:          Some(status),
        latency_ms:      Some(latency_ms),
        error:           None,
        token_mappings:  mappings,
        cache_creation_tokens,
        cache_read_tokens,
        input_tokens,
        output_tokens,
    })?;
    Ok(())
}

/// Above this character count, content is chunked at paragraph
/// boundaries before storage (see chunk_for_storage). Tuned for the
/// resume case: a typical resume runs 3–10 KB; chunks per paragraph
/// (job entry, summary section) work out to ~200–800 chars each,
/// well-suited for BGE's 512-token window.
const CHUNK_THRESHOLD_CHARS: usize = 1500;

/// Split a long pasted block into semantic chunks for embedding.
/// Single-vector embeddings of long content diffuse the signal across
/// many topics — Casey's resume (6 KB) was stored as one row with
/// one vector, and recall on "where have I worked?" couldn't surface
/// it because the embedding averaged across personal info, summary,
/// every job, etc. Per-paragraph chunks let each section's embedding
/// stay topically focused and individually recallable.
///
/// Strategy: split on `\n\n` (paragraph boundaries) — the most reliable
/// semantic break in formatted text. Filter out empty/short fragments.
/// If the result is a single chunk (no paragraph breaks found),
/// preserve the original text as-is (no point chunking a one-line
/// message just because it's long).
fn chunk_for_storage(text: &str) -> Vec<String> {
    if text.chars().count() <= CHUNK_THRESHOLD_CHARS {
        return vec![text.to_string()];
    }
    let chunks: Vec<String> = text
        .split("\n\n")
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() >= STORE_MIN_CHARS)
        .map(str::to_string)
        .collect();
    if chunks.len() <= 1 {
        // No paragraph breaks worth using — keep as a single chunk.
        return vec![text.to_string()];
    }
    chunks
}

async fn store_interaction(
    state:      &Arc<HandlerState>,
    text:       &str,
    role:       &str,
    turn_group: &str,
) -> Result<()> {
    // Resolve profile (drop the storage lock before .await, same as
    // recall — clippy::await_holding_lock is enforced). SCI-156:
    // honor the active profile; fall back to "work" if it's missing.
    let profile_name = state.active_profile_name();
    let profile_id = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        let resolved = storage.get_profile(&profile_name)?
            .or(storage.get_profile(DEFAULT_STORE_PROFILE)?);
        let Some(p) = resolved else {
            return Ok(()); // both profiles missing → no-op, same as TS
        };
        p.id
    };

    let chunks = chunk_for_storage(text);
    let chunk_count = chunks.len();
    // Group-id correlates chunks from the same paste so a future UI
    // can render them together. Cheap, just a millisecond timestamp.
    let chunk_group = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    for (idx, chunk) in chunks.iter().enumerate() {
        // Embed each chunk separately. Cheap with NoopEmbedder (returns
        // zeros); ~tens of ms with BgeEmbedder. Off the critical path
        // because we're inside a `tokio::spawn`.
        let embedding = state.embedder.embed(chunk).await?;

        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        let mut metadata = sci_memory::Metadata::new();
        metadata.insert("has_response".into(), serde_json::Value::Bool(true));
        metadata.insert("source".into(),       serde_json::Value::String("rust-helper".into()));
        metadata.insert("role".into(),         serde_json::Value::String(role.into()));
        metadata.insert("turn_group".into(),   serde_json::Value::String(turn_group.into()));
        if chunk_count > 1 {
            metadata.insert(
                "chunk".into(),
                serde_json::json!({"index": idx, "of": chunk_count, "group": chunk_group.to_string()}),
            );
        }
        storage.store_episodic(&sci_memory::StoreEpisodicInput {
            profile_id: &profile_id,
            content:    chunk,
            embedding:  &embedding,
            source:     Some("proxy"),
            agent_id:   None,
            metadata,
        })?;
    }
    if chunk_count > 1 {
        tracing::debug!(
            role,
            chunks = chunk_count,
            total_chars = text.chars().count(),
            "stored chunked memory",
        );
    }
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
) -> Result<(BodyStream, bytes::Bytes, String)> {
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
    // The flight-recorder also wants the deanonymized assistant text
    // so it can be paired with the user prompt + persisted to
    // audit_turns. Extract it after deanon so the captured text matches
    // what the client sees.
    let (rewritten, assistant_text): (Vec<u8>, String) = match serde_json::from_slice::<Value>(&buf) {
        Ok(mut v) => {
            deanonymize_messages_response(&mut v, &session_map);
            let assistant_text = extract_assistant_text(&v);
            let bytes = serde_json::to_vec(&v).unwrap_or(buf);
            (bytes, assistant_text)
        }
        Err(_) => (buf, String::new()),
    };

    let stream: BodyStream = Box::pin(futures::stream::once(async move {
        Ok::<_, std::io::Error>(bytes::Bytes::from(rewritten))
    }));
    Ok((stream, raw, assistant_text))
}

/// Pull the user-visible text out of a deanonymized non-streaming
/// `/v1/messages` response. Concatenates every `content[*].text` block
/// in order. Skips `thinking` blocks (the model's chain-of-thought
/// isn't part of what the user reads as the answer) and tool-use blocks
/// (those carry tool args, not prose). Mirrors what
/// `DeanonymizingStream` accumulates in `full_response` on the SSE
/// path so the audit_turns row carries the same artifact regardless
/// of streaming vs non-streaming.
fn extract_assistant_text(value: &Value) -> String {
    let Some(content) = value.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut out = String::new();
    for block in content {
        let block_type = block.get("type").and_then(|v| v.as_str());
        if block_type == Some("text")
            && let Some(t) = block.get("text").and_then(|v| v.as_str())
        {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(t);
        }
    }
    out
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
/// Add `cache_control: {type: "ephemeral"}` to the two largest static
/// prefixes in every request:
///
///   1. **tools array last entry** — marks the entire 77-tool schema
///      (~20k tokens) as cacheable. Tools are static per-session.
///   2. **artifact instructions message** — the first large user message
///      (~3k tokens), identical on every turn.
///
/// Anthropic limits cache_control to 4 blocks per request. This function
/// counts existing blocks first (some may already be in system[] or in
/// conversation history from prior turns) and only adds up to that cap.
/// Blocks that already carry cache_control are not marked again.
///
/// Cache TTL: 5 minutes (Anthropic ephemeral).
fn mark_cache_control(body: &mut Value) {
    // Anthropic hard limit — never send more than this many cache_control blocks.
    const CACHE_CONTROL_LIMIT: usize = 4;

    // Strip ALL cache_control blocks that accumulated in messages[] from
    // prior turns. We re-add exactly the ones we want below. This is the
    // correct fix for both old sessions (history already over limit) and
    // new ones. system[] and tools[] are left alone — those are ours.
    strip_message_cache_controls(body);

    let existing = count_cache_control_blocks(body);
    let mut budget = CACHE_CONTROL_LIMIT.saturating_sub(existing);
    if budget == 0 { return; }

    let cc = serde_json::json!({"type": "ephemeral"});

    // 1. Tools — mark the last tool (idempotent: skip if already marked).
    if budget > 0 {
        if let Some(tools) = body.get_mut("tools").and_then(|v| v.as_array_mut()) {
            if let Some(last) = tools.last_mut().and_then(|v| v.as_object_mut()) {
                if !last.contains_key("cache_control") {
                    last.insert("cache_control".into(), cc.clone());
                    budget -= 1;
                }
            }
        }
    }

    if budget == 0 { return; }

    // 2. Artifact instructions — find the first user message whose content
    //    is a long string (>500 chars) and does NOT already have cache_control.
    const ARTIFACT_MIN_LEN: usize = 500;
    if let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) {
        // Search only the first 5 messages — artifact instructions are always
        // near the top; scanning the whole array is unnecessary.
        for msg in messages.iter_mut().take(5) {
            if msg.get("role").and_then(|v| v.as_str()) != Some("user") {
                continue;
            }
            match msg.get_mut("content") {
                Some(Value::String(s)) if s.len() >= ARTIFACT_MIN_LEN => {
                    // Already a string — convert to typed block so we can
                    // attach cache_control. Not already marked (strings can't
                    // carry cache_control), so no idempotency check needed.
                    let text = s.clone();
                    *msg.get_mut("content").unwrap() = serde_json::json!([{
                        "type": "text",
                        "text": text,
                        "cache_control": {"type": "ephemeral"}
                    }]);
                    break;
                }
                Some(Value::Array(blocks)) => {
                    // Check if the last block already has cache_control — if so
                    // this message was already marked in a previous turn and is
                    // now sitting in conversation history. Don't double-mark.
                    let already_marked = blocks.last()
                        .and_then(|b| b.as_object())
                        .map(|o| o.contains_key("cache_control"))
                        .unwrap_or(false);
                    if already_marked { break; }

                    let total_len: usize = blocks.iter()
                        .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                        .map(|s| s.len())
                        .sum();
                    if total_len >= ARTIFACT_MIN_LEN {
                        if let Some(last_block) = blocks.last_mut().and_then(|v| v.as_object_mut()) {
                            last_block.insert("cache_control".into(), cc);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
}

/// Remove cache_control from every content block inside messages[].
/// Called before re-applying markers so stale accumulated blocks from
/// prior turns don't push the count over Anthropic's 4-block limit.
/// system[] and tools[] are intentionally left untouched.
fn strip_message_cache_controls(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for msg in messages.iter_mut() {
        let Some(content) = msg.get_mut("content").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for block in content.iter_mut() {
            if let Some(obj) = block.as_object_mut() {
                obj.remove("cache_control");
            }
        }
    }
}

/// Count cache_control blocks already present in the request body so
/// mark_cache_control can stay under Anthropic's 4-block hard limit.
/// Scans system[], tools[], and the first few messages[].
fn count_cache_control_blocks(body: &Value) -> usize {
    let mut count = 0usize;

    // system[]
    if let Some(arr) = body.get("system").and_then(|v| v.as_array()) {
        for block in arr {
            if block.get("cache_control").is_some() { count += 1; }
        }
    }
    // tools[]
    if let Some(arr) = body.get("tools").and_then(|v| v.as_array()) {
        for tool in arr {
            if tool.get("cache_control").is_some() { count += 1; }
        }
    }
    // messages[] — only first 10; cache_control on old history is the bug we're fixing
    if let Some(arr) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in arr.iter().take(10) {
            if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if block.get("cache_control").is_some() { count += 1; }
                }
            }
        }
    }
    count
}

// ── Tool result truncation ───────────────────────────────────────────────────

/// Individual tool results larger than this are head+tail truncated before
/// forwarding. A single `read_file` on a 200-line source file or a
/// `shell_exec` log dump can hit 20–100 KB — well above what the model needs
/// for most tool interactions. 8 KB is generous for a tool result while still
/// cutting multi-KB bloat to a fraction of its original size.
const MAX_TOOL_RESULT_BYTES: usize = 8_192; // 8 KB per tool result
/// Lines to keep from the beginning of a truncated tool result.
const TOOL_RESULT_HEAD_LINES: usize = 50;
/// Lines to keep from the end of a truncated tool result.
const TOOL_RESULT_TAIL_LINES: usize = 20;

/// Walk `messages` looking for user-role messages that contain
/// `tool_result` content blocks. For each block whose text content
/// exceeds [`MAX_TOOL_RESULT_BYTES`], replace the text with:
///
/// ```text
/// <head lines>
/// ... [N lines truncated] ...
/// <tail lines>
/// ```
///
/// Tool results can be a string or an array of typed blocks
/// (`[{"type":"text","text":"…"}]`). Both shapes are handled.
///
/// Returns the number of blocks truncated (for the tracing log call-site).
fn truncate_tool_results(body: &mut Value) -> usize {
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return 0;
    };

    let mut truncated = 0usize;

    for message in messages.iter_mut() {
        if message.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = message.get_mut("content").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for block in content.iter_mut() {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            match block.get("content") {
                // Shape 1: content is a plain string.
                Some(Value::String(_)) => {
                    let text = block["content"].as_str().unwrap();
                    if text.len() <= MAX_TOOL_RESULT_BYTES {
                        continue;
                    }
                    let replacement = head_tail_truncate(text);
                    block["content"] = Value::String(replacement);
                    truncated += 1;
                }
                // Shape 2: content is an array of typed blocks.
                Some(Value::Array(_)) => {
                    let inner = block["content"].as_array_mut().unwrap();
                    for inner_block in inner.iter_mut() {
                        if inner_block.get("type").and_then(|v| v.as_str()) != Some("text") {
                            continue;
                        }
                        let text = match inner_block.get("text").and_then(|v| v.as_str()) {
                            Some(t) if t.len() > MAX_TOOL_RESULT_BYTES => t,
                            _ => continue,
                        };
                        let replacement = head_tail_truncate(text);
                        inner_block["text"] = Value::String(replacement);
                        truncated += 1;
                    }
                }
                // No content field, or an unexpected shape — leave alone.
                _ => {}
            }
        }
    }

    truncated
}

/// Replace the body of a large string with its first
/// [`TOOL_RESULT_HEAD_LINES`] lines + a count banner +
/// last [`TOOL_RESULT_TAIL_LINES`] lines.
fn head_tail_truncate(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let keep = TOOL_RESULT_HEAD_LINES + TOOL_RESULT_TAIL_LINES;
    if total <= keep {
        // Byte-length was over threshold but line count is small
        // (very long single lines). In that case just hard-truncate
        // at MAX_TOOL_RESULT_BYTES and append a byte-count note.
        let mut out = text[..MAX_TOOL_RESULT_BYTES].to_string();
        out.push_str(&format!(
            "\n... [{} bytes truncated] ...",
            text.len() - MAX_TOOL_RESULT_BYTES,
        ));
        return out;
    }
    let skipped = total - keep;
    let head = lines[..TOOL_RESULT_HEAD_LINES].join("\n");
    let tail = lines[total - TOOL_RESULT_TAIL_LINES..].join("\n");
    format!("{head}\n... [{skipped} lines truncated] ...\n{tail}")
}

/// Body size above which we trim old messages to keep requests fast and cheap.
/// Claude supports 200k tokens (~800KB at ~4 bytes/token). We trigger at 160k
/// tokens (~640KB) to leave 40k tokens of headroom for the response.
const CONTEXT_TRIM_THRESHOLD_BYTES: usize = 640_000;
/// Most-recent messages to keep when trimming.
/// Matches the UI render window (40 messages) so what the user sees ≈ what
/// the model has in its active context.
const CONTEXT_WINDOW_KEEP: usize = 40;
/// Max characters per user turn in the prior-context summary.
const SUMMARY_USER_CHARS: usize = 400;
/// Max characters per assistant turn in the prior-context summary.
const SUMMARY_ASST_CHARS: usize = 300;
/// Hard cap on the total summary block size.
const SUMMARY_MAX_CHARS: usize = 6_000;

/// Trim the `messages` array when the raw body exceeds the threshold.
///
/// Before dropping the old messages, extract a compact conversational
/// summary (user questions + assistant prose responses, no tool noise)
/// and inject it as messages[1] so the model retains thread continuity.
/// The summary goes through the normal anonymizer pass that runs after
/// this function, so PII in the summary is masked correctly.
///
/// Keeps messages[0] (artifact instructions) + summary + last
/// CONTEXT_WINDOW_KEEP turns.
fn trim_context_window(body: &mut Value, raw_body_len: usize) {
    if raw_body_len <= CONTEXT_TRIM_THRESHOLD_BYTES {
        return;
    }
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let total = messages.len();
    if total <= CONTEXT_WINDOW_KEEP + 1 {
        return; // nothing to trim
    }
    let keep_from = total - CONTEXT_WINDOW_KEEP;
    let head = messages[0].clone();

    // Build the summary BEFORE draining so we still have the content.
    let summary = build_prior_context_summary(&messages[1..keep_from]);

    messages.drain(1..keep_from);
    messages[0] = head;

    // After trimming, collect all tool_use IDs that are still present in
    // the kept assistant messages. Any tool_result block in a kept user
    // message whose tool_use_id is NOT in this set is an orphan — it
    // references a tool call that was just dropped. Anthropic returns
    // `400 unexpected tool_use_id in tool_result` for these.
    let live_tool_use_ids: std::collections::HashSet<String> = messages
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
        .filter_map(|m| m.get("content").and_then(|v| v.as_array()))
        .flat_map(|blocks| blocks.iter())
        .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
        .filter_map(|b| b.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let mut orphaned = 0u32;
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") { continue; }
        let Some(content) = msg.get_mut("content").and_then(|v| v.as_array_mut()) else { continue; };
        let before = content.len();
        content.retain(|block| {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                return true; // keep non-tool_result blocks
            }
            let Some(id) = block.get("tool_use_id").and_then(|v| v.as_str()) else {
                return true; // no id → keep (let orphan_repair handle it)
            };
            live_tool_use_ids.contains(id) // keep only if tool_use still exists
        });
        orphaned += (before - content.len()) as u32;
    }

    if orphaned > 0 {
        tracing::warn!(
            target: "sci_handlers::context",
            orphaned,
            "removed {} orphan tool_result block(s) after trim (their tool_use was in the dropped range)",
            orphaned,
        );
    }

    // Inject the summary as messages[1] — sits between the artifact
    // instructions and the retained conversation history. The anonymizer
    // processes it as a normal user message, masking any PII.
    let had_summary = !summary.is_empty();
    if had_summary {
        messages.insert(1, serde_json::json!({
            "role":    "user",
            "content": summary,
        }));
    }

    tracing::info!(
        target: "sci_handlers::context",
        original   = total,
        kept       = messages.len(),
        summarised = keep_from - 1,
        had_summary,
        orphaned_removed = orphaned,
        "context window trimmed: {} → {} messages ({} dropped{}{})",
        total, messages.len(), keep_from - 1,
        if had_summary { ", prior-context summary injected" } else { "" },
        if orphaned > 0 { format!(", {} orphan tool_results removed", orphaned) } else { String::new() },
    );
}

/// Walk the messages that are about to be dropped and produce a compact
/// plain-text summary of the conversational content.
///
/// Rules:
///   - User text blocks  → first SUMMARY_USER_CHARS chars
///   - Assistant text responses → first SUMMARY_ASST_CHARS chars
///   - tool_use / tool_result blocks → skipped (noisy, already in memory)
///   - Automation prompts (titles, recap instructions) → skipped
///   - Total capped at SUMMARY_MAX_CHARS
fn build_prior_context_summary(messages: &[Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut total_chars = 0usize;

    for msg in messages {
        if total_chars >= SUMMARY_MAX_CHARS { break; }

        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let (limit, label) = match role {
            "user"      => (SUMMARY_USER_CHARS, "You"),
            "assistant" => (SUMMARY_ASST_CHARS, "Me"),
            _           => continue,
        };

        let text = extract_conversational_text(msg.get("content"), role);
        if text.is_empty() { continue; }

        // Skip agent automation prompts that slipped through into history.
        if is_agent_automation_prompt(&text) { continue; }

        let truncated = if text.chars().count() > limit {
            let cut: String = text.chars().take(limit).collect();
            format!("{cut}\u{2026}") // … ellipsis
        } else {
            text
        };

        let line = format!("{label}: {truncated}");
        total_chars += line.len();
        lines.push(line);
    }

    if lines.is_empty() {
        return String::new();
    }

    format!(
        "[Automatic context compaction — {} earlier turns have been summarized below. \
This is handled transparently by the system; the user does NOT need to start a new \
conversation. Continue naturally from where we left off.]\n{}\n[End prior context]",
        lines.len(),
        lines.join("\n"),
    )
}

/// Pull plain text out of a content field, skipping tool noise.
/// For user messages: skip tool_result blocks.
/// For assistant messages: skip tool_use blocks (the input JSON isn't prose).
fn extract_conversational_text(content: Option<&Value>, role: &str) -> String {
    let skip_type = match role {
        "user"      => "tool_result",
        "assistant" => "tool_use",
        _           => return String::new(),
    };
    match content {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|v| v.as_str()) != Some(skip_type))
            .filter_map(|b| match b.get("type").and_then(|v| v.as_str()) {
                Some("text") => b.get("text").and_then(|v| v.as_str()).map(str::trim),
                _            => None,
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// piece of user-visible text. Mutates the JSON in place. Returns the
/// list of detected entities for observability — handlers don't use
/// it today but the shell logs `🔒 masked N` based on the count.
/// Circuit breaker for the anonymizer. If a single request produces more
/// unique entities than this, roll back all substitutions and pass the
/// request through unmodified.
///
/// ## What this protects against
/// An unanticipated NER false-positive storm that would corrupt tool schemas
/// and cause the model to loop (the May 2026 LangGraph recursion-limit
/// cascade). That specific cascade was fixed by SCI-199 (skip assistant
/// history) + SCI-203 (state abbreviation context gates), so the circuit
/// breaker is now a pure safety net for future bugs.
///
/// ## Why 100, not 25
/// Per-request entity count is the WRONG signal for cascade detection.
/// The May 2026 cascade grew *gradually* — adding 1-5 entities per turn
/// over 90 minutes, from 23 → 92+. A single dense document (resume, bio,
/// contract) legitimately produces 40-80 entities in ONE turn, then drops
/// back to normal. A resume with 37 substitutions is correct behavior.
///
/// 100 covers legitimate dense-PII documents while still catching truly
/// pathological behavior (100+ unique entities in one request requires
/// either an extreme document or a catastrophic NER bug).
///
/// ## Better signal (future work)
/// Cross-turn growth rate: if masked_count increases by >15 on three
/// consecutive turns, that's a cascade pattern. Requires persisted state
/// across requests. The current threshold is the pragmatic stop-gap.
const ANON_CIRCUIT_BREAKER: usize = 100;

fn anonymize_messages_body(body: &mut Value, map: &mut TokenMap) -> Result<Vec<Entity>> {
    let mut all_entities = Vec::new();

    // SCI-201: do NOT anonymize the top-level `system` field.
    // The system prompt is LibreChat / Claude Code boilerplate containing
    // CamelCase identifiers (LineChart, DayPicker, AlertDialog, etc.) that
    // the CamelCase pass was tokenizing as PROJECT entities. Those tokens
    // entered token_mappings, then on subsequent turns the placeholder-
    // annotated system prompt re-entered the context and was injected as
    // visible user-turn text in the UI. The system prompt is not user PII;
    // skipping it breaks the injection loop with zero privacy tradeoff.

    // The per-request snapshot is taken by the caller (handle_messages_request)
    // and passed in for rollback. We re-snapshot here only for the internal
    // per-request breaker — caller's snapshot is used for cascade rollback.
    let pre_anon_snapshot = body
        .get("messages")
        .cloned()
        .unwrap_or(Value::Array(vec![]));

    // `messages[*].content` is either a string or an array of typed
    // content blocks. We only touch `text` blocks.
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return Ok(all_entities);
    };
    for message in messages {
        // SCI-199: skip assistant-role messages. The assistant's prior
        // turns are already deanonymized plain-English when LibreChat
        // stores them; re-anonymizing creates a vocab-feedback loop
        // where the model sees its own placeholder-form prose and
        // learns that [PLACE_N] IS the English word. User and system
        // messages get anonymized normally; tool_result blocks (which
        // appear in user-role messages) also get anonymized through
        // the normal path since they're part of user-role content.
        if message.get("role").and_then(|v| v.as_str()) == Some("assistant") {
            continue;
        }
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

    // Circuit breaker: too many masked entities means the NER is over-firing
    // (cascade from conversation history, unanticipated pattern, etc.). Roll
    // back every substitution and let the request pass through clean rather
    // than risk tool-schema corruption → model loops → LangGraph recursion
    // limit error.
    if all_entities.len() > ANON_CIRCUIT_BREAKER {
        tracing::warn!(
            target: "sci_handlers::anonymizer",
            entity_count = all_entities.len(),
            threshold    = ANON_CIRCUIT_BREAKER,
            "circuit breaker fired: too many masked entities; \
             rolling back substitutions and passing request through unmasked. \
             Check NER rules for over-matching on conversation history."
        );
        // Restore the pre-anonymization messages array.
        if let Some(msgs) = body.get_mut("messages") {
            *msgs = pre_anon_snapshot;
        }
        // Discard the polluted token map so no bad entries reach the DB.
        *map = TokenMap::default();
        return Ok(Vec::new());
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
    let profile_name = state.active_profile_name();
    let profile_id = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        let resolved = storage.get_profile(&profile_name)?
            .or(storage.get_profile("work")?);
        let Some(p) = resolved else { return Ok(()); };
        p.id
    };

    let query_emb = state.embedder.embed(seed).await?;

    let hits = {
        let storage = state.storage.lock()
            .map_err(|e| HandlerError::Memory(format!("storage lock poisoned: {e}")))?;
        storage.recall(&sci_memory::RecallQuery {
            query_embedding:    &query_emb,
            query:              seed,
            profile_id:         &profile_id,
            limit:              5,
            // Empty `types` searches all three classes, matching the TS
            // default for `injectMemoryContext`.
            types:              &[],
            // Cap episodic scan to the 2000 most-recent rows. Prevents
            // O(n) cosine over the full corpus (currently ~10 k) from
            // adding 200–350 ms to every request TTFT. Recent turns are
            // the most relevant; semantic/identity stay uncapped (small).
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
        // BYO key — pass through UNLESS it's the local placeholder that
        // LibreChat uses when no real key is configured. A placeholder
        // arriving here means the request came from the agents/LangChain
        // path (which reads ANTHROPIC_API_KEY from the environment) rather
        // than from a user who deliberately configured a BYO key. Fall
        // through to the OAuth cache so sci-helper can inject real creds.
        (_, Some(k)) if !k.is_empty() && !k.starts_with("sci_t_") => {
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
/// SCI-159: prepend a "Working directory" hint to the system prompt
/// when the user has set an active project. No-op when no project is
/// set (preserves prior behavior). The injected block is a separate
/// system text block — sits between the prior content and the user's
/// existing system instructions so it carries high salience without
/// burying the user's own system prompt.
///
/// Anthropic accepts `system` as either a string or an array of typed
/// blocks; this helper handles both. The injection is observable in
/// the audit_turns row's `request_body` for debugging.
pub fn inject_project_context(body: &mut Value, state: &Arc<HandlerState>) {
    let Some(path) = state.active_project_path() else { return; };
    let trimmed = path.trim();
    if trimmed.is_empty() { return; }

    let hint = format!(
        "Working directory: {trimmed}\n\nWhen the user mentions files \
         or paths without an absolute prefix, default to this directory. \
         When using filesystem tools, prefer paths under this directory.",
    );
    let block = serde_json::json!({"type": "text", "text": hint});

    match body.get_mut("system") {
        Some(Value::Array(arr)) => arr.insert(0, block),
        Some(Value::String(s)) => {
            let prior = std::mem::take(s);
            let mut blocks = vec![block];
            if !prior.is_empty() {
                blocks.push(serde_json::json!({"type": "text", "text": prior}));
            }
            body["system"] = Value::Array(blocks);
        }
        _ => {
            body["system"] = Value::Array(vec![block]);
        }
    }
}

/// Idempotent: if the existing system field already starts with the
/// canonical phrase, nothing changes (so Claude Code → Sci → Anthropic
/// chains don't accumulate duplicates).
///
/// Anthropic accepts `system` as either a string or an array of typed
/// blocks; we handle both. Absent → set to a fresh string holding just
/// the prefix.
fn prepend_claude_code_prefix(body: &mut Value) {
    let prefix = CLAUDE_CODE_SYSTEM_PREFIX;

    // Anthropic's OAuth-bearer gate is *exact-match* on the system
    // field when it's a STRING — anything appended (even another
    // sentence about tools) trips a 429 rate_limit_error. With the
    // ARRAY-of-blocks shape, only the first block has to match the
    // canonical phrase exactly; additional blocks (recall, caller's
    // own system content) are accepted. Verified by direct curl
    // bisection on 2026-05-10.
    //
    // So the fix is uniform: always convert `system` to the array
    // shape on the OAuth path, with the canonical prefix as block[0]
    // (exact, no separator) and any caller-provided system content
    // wrapped as block[1+].
    let canonical_block = serde_json::json!({"type":"text","text":prefix});

    match body.get_mut("system") {
        // String form. Convert to [{prefix}, {existing_string}] —
        // unless the existing string IS the prefix already (idempotent
        // for retries / cache hits).
        Some(Value::String(s)) => {
            if s == prefix {
                // already exactly the prefix, just promote to array
                // for shape-uniformity.
                *body.get_mut("system").unwrap() = Value::Array(vec![canonical_block]);
            } else if s.starts_with(prefix) {
                // Was prefix + extra (probably a previous string-shape
                // injection). Split: keep the prefix as block[0],
                // strip leading separator + put rest as block[1].
                let rest = s[prefix.len()..].trim_start_matches(['\n', ' ']).to_string();
                let blocks = if rest.is_empty() {
                    vec![canonical_block]
                } else {
                    vec![canonical_block, serde_json::json!({"type":"text","text":rest})]
                };
                *body.get_mut("system").unwrap() = Value::Array(blocks);
            } else if s.is_empty() {
                *body.get_mut("system").unwrap() = Value::Array(vec![canonical_block]);
            } else {
                let original = s.clone();
                *body.get_mut("system").unwrap() = Value::Array(vec![
                    canonical_block,
                    serde_json::json!({"type":"text","text":original}),
                ]);
            }
        }
        // Already an array. Make sure block[0] is the exact canonical
        // phrase. If the first text block already starts with the
        // prefix but has trailing content in the SAME block, split it.
        Some(Value::Array(blocks)) => {
            let first_text = blocks
                .first()
                .and_then(|b| {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        b.get("text").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                });
            match first_text {
                Some(t) if t == prefix => { /* perfect — leave alone */ }
                Some(t) if t.starts_with(prefix) => {
                    // Split block[0] so the prefix is alone in block[0]
                    // and the rest moves to block[1].
                    let rest = t[prefix.len()..].trim_start_matches(['\n', ' ']).to_string();
                    blocks[0] = canonical_block.clone();
                    if !rest.is_empty() {
                        blocks.insert(1, serde_json::json!({"type":"text","text":rest}));
                    }
                }
                _ => {
                    // Prefix not at block[0] — prepend.
                    blocks.insert(0, canonical_block);
                }
            }
        }
        // Absent or unsupported shape. Set fresh array.
        _ => {
            body["system"] = Value::Array(vec![canonical_block]);
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

    /// SCI-159: project mode injects a "Working directory: <path>" hint
    /// at index 0 of the system array. No-op when active_project is None.
    #[test]
    fn inject_project_context_prepends_when_set() {
        use crate::state::NoopEmbedder;
        use crate::upstream::UpstreamClient;
        use sci_memory::LocalAdapter;
        use std::sync::{Arc, Mutex};

        struct DummyUpstream;
        #[async_trait::async_trait]
        impl UpstreamClient for DummyUpstream {
            async fn send(
                &self,
                _req: crate::upstream::UpstreamRequest,
            ) -> std::result::Result<crate::upstream::UpstreamResponse, std::io::Error> {
                unreachable!()
            }
        }

        let storage  = Arc::new(Mutex::new(LocalAdapter::open_in_memory().unwrap()));
        let embedder: Arc<dyn crate::Embedder> = Arc::new(NoopEmbedder);
        let upstream: Arc<dyn UpstreamClient> = Arc::new(DummyUpstream);
        let state = Arc::new(HandlerState::new(storage, embedder, upstream));

        // No project set → no-op
        let mut body = serde_json::json!({"system": "you are helpful"});
        inject_project_context(&mut body, &state);
        assert_eq!(body["system"], "you are helpful", "no project → no change");

        // Project set → prepended as block[0], original system as block[1]
        *state.active_project.lock().unwrap() = Some("/Users/me/proj".into());
        let mut body = serde_json::json!({"system": "you are helpful"});
        inject_project_context(&mut body, &state);
        assert!(body["system"].is_array());
        let arr = body["system"].as_array().unwrap();
        assert_eq!(arr[0]["type"], "text");
        let hint = arr[0]["text"].as_str().unwrap();
        assert!(hint.starts_with("Working directory: /Users/me/proj"),
            "expected working-dir hint at block[0], got: {hint}");
        assert_eq!(arr[1]["text"], "you are helpful");
    }

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
    fn system_field_is_not_anonymized() {
        // SCI-201: system prompt is intentionally skipped by
        // anonymize_messages_body. Previously this caused CamelCase
        // identifiers in LibreChat / Claude Code boilerplate to mint
        // PROJECT tokens that re-entered context as visible placeholders
        // on the next turn.
        let mut body: Value = serde_json::from_str(
            r#"{"system":"the user works on openclaw.dev","messages":[]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut body, &mut map).unwrap();
        let s = body["system"].as_str().unwrap();
        // System field must be unchanged — no token substitution.
        assert_eq!(s, "the user works on openclaw.dev");
        assert!(map.forward.is_empty(), "no tokens should be minted from system prompt");
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

    // Note: prepend_claude_code_prefix now ALWAYS converts `system` to
    // an array — the Anthropic OAuth gate is exact-match on the
    // STRING form of system, so any deviation 429s. Array form lets
    // additional blocks ride along behind a clean canonical-prefix
    // block[0]. The tests below assert the new array shape; the
    // pre-array string-shape tests have been replaced.

    #[test]
    fn claude_code_prefix_creates_array_when_system_absent() {
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let arr = body["system"].as_array().expect("system should be an array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
    }

    #[test]
    fn claude_code_prefix_splits_string_system_into_two_blocks() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"Be terse.","messages":[]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let arr = body["system"].as_array().expect("system should be an array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
        assert_eq!(arr[1]["text"], "Be terse.");
    }

    #[test]
    fn claude_code_prefix_idempotent_on_string_system() {
        // String system that already starts with the canonical prefix
        // (with a trailing instruction) should split cleanly into
        // [{prefix}, {rest}] — the rest is preserved exactly once.
        let mut body: Value = serde_json::from_str(&format!(
            r#"{{"system":"{prefix}\n\nBe terse.","messages":[]}}"#,
            prefix = CLAUDE_CODE_SYSTEM_PREFIX,
        ))
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        let arr = body["system"].as_array().expect("array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
        assert_eq!(arr[1]["text"], "Be terse.");
        // Idempotence: running again should produce the same result.
        prepend_claude_code_prefix(&mut body);
        let arr2 = body["system"].as_array().unwrap();
        assert_eq!(arr2.len(), 2);
        assert_eq!(arr2[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
        assert_eq!(arr2[1]["text"], "Be terse.");
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
    fn artifact_instructions_blocked_from_memory() {
        // LibreChat sends the artifact system prompt as messages[0] with
        // role=user on every request. It must not be stored as episodic memory.
        let artifact = "The assistant can create and reference artifacts during conversations.\n\
                         Artifacts are for substantial, self-contained content…";
        assert!(
            is_agent_automation_prompt(artifact),
            "artifact instructions must be treated as agent boilerplate, not user input"
        );
        // Real user input must not be blocked.
        assert!(
            !is_agent_automation_prompt("What's the capital of France?"),
            "real user question should not be filtered"
        );
        assert!(
            !is_agent_automation_prompt("I'm driving to OK today"),
            "real user message should not be filtered"
        );
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
    fn claude_code_prefix_handles_empty_string_system_as_array() {
        let mut body: Value = serde_json::from_str(
            r#"{"system":"","messages":[]}"#,
        )
        .unwrap();
        prepend_claude_code_prefix(&mut body);
        // Empty + prefix should produce a single-block array with
        // exactly the canonical prefix.
        let arr = body["system"].as_array().expect("system should be array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["text"], CLAUDE_CODE_SYSTEM_PREFIX);
    }

    // ── chunking on storage (long-paste recall fix) ───────────────────

    #[test]
    fn chunk_for_storage_short_text_unchanged() {
        let s = "Hi, my name is Casey.";
        assert_eq!(chunk_for_storage(s), vec![s.to_string()]);
    }

    #[test]
    fn chunk_for_storage_long_no_breaks_unchanged() {
        // No paragraph breaks → keep as one chunk even if long.
        let s = "a".repeat(2000);
        assert_eq!(chunk_for_storage(&s), vec![s.clone()]);
    }

    #[test]
    fn chunk_for_storage_paragraph_split() {
        // Resume-shaped: long enough to trigger threshold, multiple
        // paragraph breaks.
        let para_a = "Director of Product Management at linqd. ".repeat(40);
        let para_b = "Head of Strategy at ITRS Group. ".repeat(40);
        let para_c = "VP Business Development at OP5. ".repeat(40);
        let combined = format!("{para_a}\n\n{para_b}\n\n{para_c}");
        let chunks = chunk_for_storage(&combined);
        assert_eq!(chunks.len(), 3, "expected 3 paragraphs, got {}", chunks.len());
        assert!(chunks[0].contains("linqd"));
        assert!(chunks[1].contains("ITRS"));
        assert!(chunks[2].contains("OP5"));
    }

    #[test]
    fn chunk_for_storage_filters_short_fragments() {
        let para_a = "x".repeat(2000);
        let combined = format!("{para_a}\n\nhi\n\n");  // "hi" is 2 chars, below STORE_MIN_CHARS
        let chunks = chunk_for_storage(&combined);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].starts_with("x"));
    }

    // ── widened agent-automation filter ──────────────────────────────

    #[test]
    fn agent_automation_catches_xml_tag_envelopes() {
        assert!(is_agent_automation_prompt("<system-reminder>foo bar baz"));
        assert!(is_agent_automation_prompt("<task>do the thing</task>"));
        assert!(is_agent_automation_prompt("<conversation>...</conversation>"));
        // mixed case in tag → reject (real xml is lowercase by Claude convention)
        assert!(!is_agent_automation_prompt("<TASK>"));
        // tag with space (not a tag)
        assert!(!is_agent_automation_prompt("<not a tag>"));
    }

    #[test]
    fn agent_automation_catches_known_librechat_prefixes() {
        assert!(is_agent_automation_prompt(
            "Provide a concise, 5-word-or-less title for the conversation, using title case"
        ));
        assert!(is_agent_automation_prompt(
            "The user stepped away and is coming back. Recap in under 40 words"
        ));
        assert!(is_agent_automation_prompt(
            "Recap in under 60 words: what did the user just say?"
        ));
        assert!(is_agent_automation_prompt(
            "Summarize the following conversation"
        ));
        // Real user messages with similar shape stay through
        assert!(!is_agent_automation_prompt("Provide me feedback on this code"));
        assert!(!is_agent_automation_prompt("Recap what I just said"));  // user might say this
    }

    // ── SCI-200 orphan tool_use guard ─────────────────────────────────

    #[test]
    fn orphan_repair_happy_path_is_noop() {
        let mut body = serde_json::json!({
            "messages": [
                { "role": "user",      "content": [{ "type": "text", "text": "ping" }] },
                { "role": "assistant", "content": [
                    { "type": "text",     "text": "ok" },
                    { "type": "tool_use", "id":   "toolu_A", "name": "x", "input": {} },
                ]},
                { "role": "user",      "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_A", "content": "done" },
                ]},
            ]
        });
        let n = repair_orphan_tool_uses(&mut body);
        assert_eq!(n, 0, "well-formed conversations must not be touched");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn orphan_repair_injects_synthetic_into_existing_user_message() {
        let mut body = serde_json::json!({
            "messages": [
                { "role": "user",      "content": [{ "type": "text", "text": "ping" }] },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_orphan", "name": "write", "input": {} },
                    { "type": "tool_use", "id": "toolu_ok",     "name": "shell", "input": {} },
                ]},
                { "role": "user",      "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_ok", "content": "done" },
                ]},
            ]
        });
        let n = repair_orphan_tool_uses(&mut body);
        assert_eq!(n, 1, "expected exactly one synthetic result for the orphan");

        let content = body["messages"][2]["content"].as_array().unwrap();
        assert!(
            content.iter().any(|c|
                c["type"] == "tool_result"
                && c["tool_use_id"] == "toolu_orphan"
                && c["is_error"] == true
            ),
            "synthetic tool_result for orphan not found: {content:?}"
        );
        assert!(
            content.iter().any(|c|
                c["type"] == "tool_result"
                && c["tool_use_id"] == "toolu_ok"
            ),
            "healthy tool_result must remain in place: {content:?}"
        );
    }

    #[test]
    fn orphan_repair_creates_new_user_message_when_assistant_is_last() {
        let mut body = serde_json::json!({
            "messages": [
                { "role": "user",      "content": [{ "type": "text", "text": "ping" }] },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_orphan", "name": "x", "input": {} },
                ]},
            ]
        });
        let n = repair_orphan_tool_uses(&mut body);
        assert_eq!(n, 1);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3, "must append a new user message for the synthetic result");
        assert_eq!(messages[2]["role"], "user");
        let content = messages[2]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"],        "tool_result");
        assert_eq!(content[0]["tool_use_id"], "toolu_orphan");
        assert_eq!(content[0]["is_error"],    true);
    }

    #[test]
    fn orphan_repair_handles_multiple_orphans_in_single_assistant_message() {
        let mut body = serde_json::json!({
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_a", "name": "x", "input": {} },
                    { "type": "tool_use", "id": "toolu_b", "name": "y", "input": {} },
                    { "type": "tool_use", "id": "toolu_c", "name": "z", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_b", "content": "ok" },
                ]},
            ]
        });
        let n = repair_orphan_tool_uses(&mut body);
        assert_eq!(n, 2, "two of three tool_uses are orphans");

        let content = body["messages"][1]["content"].as_array().unwrap();
        let ids: std::collections::HashSet<&str> = content
            .iter()
            .filter_map(|c| c["tool_use_id"].as_str())
            .collect();
        for expected in ["toolu_a", "toolu_b", "toolu_c"] {
            assert!(ids.contains(expected), "missing tool_result for {expected}: {content:?}");
        }
    }

    // ── Tool result truncation ──────────────────────────────────────────

    #[test]
    fn truncate_tool_results_noop_on_small_result() {
        let small = "x".repeat(100);
        let mut body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_x",
                    "content": small.clone()
                }]
            }]
        });
        let n = truncate_tool_results(&mut body);
        assert_eq!(n, 0, "small result must not be touched");
        assert_eq!(
            body["messages"][0]["content"][0]["content"].as_str().unwrap(),
            &small,
        );
    }

    #[test]
    fn truncate_tool_results_string_content_shape() {
        // 800 lines × ~12 chars ≈ 9.6 KB — well above the 8 KB threshold.
        let lines: Vec<String> = (0..800).map(|i| format!("line {:06}", i)).collect();
        let big = lines.join("\n");
        assert!(big.len() > MAX_TOOL_RESULT_BYTES, "test pre-condition: {} bytes", big.len());

        let mut body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_x",
                    "content": big
                }]
            }]
        });
        let n = truncate_tool_results(&mut body);
        assert_eq!(n, 1);
        let result = body["messages"][0]["content"][0]["content"].as_str().unwrap();
        // Should contain head and tail lines.
        assert!(result.contains("line 000000"), "head missing: {result:.80}");
        assert!(result.contains("line 000799"), "tail missing: {result:.80}");
        // Middle should be truncated.
        assert!(result.contains("lines truncated"), "banner missing: {result:.80}");
        assert!(!result.contains("line 000400"), "middle line must be gone: {result:.80}");
        // Must be under the byte limit (with banner overhead, still much smaller).
        assert!(result.len() < big.len(), "truncated must be shorter");
    }

    #[test]
    fn truncate_tool_results_array_content_shape() {
        // Same content but wrapped in the typed-blocks array shape.
        let lines: Vec<String> = (0..800).map(|i| format!("line {:06}", i)).collect();
        let big = lines.join("\n");

        let mut body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_x",
                    "content": [{"type": "text", "text": big}]
                }]
            }]
        });
        let n = truncate_tool_results(&mut body);
        assert_eq!(n, 1);
        let result = body["messages"][0]["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(result.contains("line 000000"));
        assert!(result.contains("line 000799"));
        assert!(result.contains("lines truncated"));
    }

    #[test]
    fn truncate_tool_results_skips_assistant_messages() {
        // tool_result blocks only appear in user messages in practice,
        // but confirm assistant messages are skipped even if malformed.
        let big = "x\n".repeat(5000);
        let mut body = serde_json::json!({
            "messages": [{
                "role": "assistant",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_x",
                    "content": big.clone()
                }]
            }]
        });
        let n = truncate_tool_results(&mut body);
        assert_eq!(n, 0, "assistant-role messages must not be touched");
    }

    #[test]
    fn truncate_tool_results_multiple_blocks_in_one_message() {
        let big = "line\n".repeat(5000); // definitely > 8 KB
        let small = "tiny result";
        let mut body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "a", "content": big.clone()},
                    {"type": "tool_result", "tool_use_id": "b", "content": small},
                    {"type": "tool_result", "tool_use_id": "c", "content": big.clone()},
                ]
            }]
        });
        let n = truncate_tool_results(&mut body);
        assert_eq!(n, 2, "only the two large blocks should be truncated");
        assert!(
            body["messages"][0]["content"][1]["content"].as_str().unwrap() == small,
            "small block must be untouched",
        );
    }

    #[test]
    fn head_tail_truncate_few_long_lines_byte_truncates() {
        // Single very long line — fewer than HEAD+TAIL lines total,
        // so the byte-truncation fallback fires.
        let long_line = "A".repeat(MAX_TOOL_RESULT_BYTES * 2);
        let result = head_tail_truncate(&long_line);
        assert!(result.len() <= MAX_TOOL_RESULT_BYTES + 60, // +banner
            "byte truncation must cap length: {}", result.len());
        assert!(result.contains("bytes truncated"), "byte banner missing");
    }

    #[test]
    fn orphan_repair_skips_when_messages_missing_or_string_content() {
        let mut body = serde_json::json!({});
        assert_eq!(repair_orphan_tool_uses(&mut body), 0);

        let mut body = serde_json::json!({
            "messages": [
                { "role": "assistant", "content": "plain string — no tool_use blocks possible" },
            ]
        });
        assert_eq!(repair_orphan_tool_uses(&mut body), 0);
    }

    #[test]
    fn orphan_repair_handles_orphans_across_multiple_assistant_messages() {
        // Two separate assistant→user pairs, each with an orphan. The
        // repair pass must handle both without index-shift confusion.
        let mut body = serde_json::json!({
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_x1", "name": "x", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "text", "text": "follow-up question" },
                ]},
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_x2", "name": "y", "input": {} },
                ]},
                { "role": "user", "content": [
                    { "type": "text", "text": "another question" },
                ]},
            ]
        });
        let n = repair_orphan_tool_uses(&mut body);
        assert_eq!(n, 2, "both assistant turns have orphans");

        // Each follow-up user message must now contain its synthetic result.
        for (user_idx, expected_id) in [(1, "toolu_x1"), (3, "toolu_x2")] {
            let content = body["messages"][user_idx]["content"].as_array().unwrap();
            assert!(
                content.iter().any(|c|
                    c["type"] == "tool_result" && c["tool_use_id"] == expected_id
                ),
                "expected synthetic result for {expected_id} at messages[{user_idx}]: {content:?}",
            );
        }
    }
}
