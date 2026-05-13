//! OpenAI `/v1/chat/completions` handler (SCI-132).
//!
//! Pipeline mirrors the Anthropic handler — anonymize, recall + inject
//! memory, forward to api.openai.com (or openrouter.ai), stream back
//! through the deanonymizer. Only the request/response shape changes:
//!
//!   - **Request**: `{messages: [{role, content: string|array}], stream, model, ...}`
//!     with `content` either a string or an array of typed parts. We
//!     anonymize string content + the `text` field of each `text` part.
//!   - **Auth**: `Authorization: Bearer sk-…`. The credential injector
//!     in the platform shell stamps this before we see the request.
//!   - **Response**: SSE stream of `data: {chat.completion.chunk}` per
//!     chunk, terminated by `data: [DONE]`. Deanonymizer (in
//!     `deanonymize_stream.rs`) recognizes `object: "chat.completion.chunk"`
//!     and swaps tokens in `choices[*].delta.content`.
//!
//! TS reference: `packages/proxy/src/handlers/openai.ts`. The TS
//! version routes through OpenRouter for the Hub's centralized billing
//! model; the Rust port goes direct to the upstream the user requested
//! (`api.openai.com` for OpenAI, `openrouter.ai` for OpenRouter) with
//! the user's BYO Bearer. OpenRouter routing is a Hub concern, not
//! an agent concern.

use crate::deanonymize_stream::DeanonymizingStream;
use crate::state::HandlerState;
use crate::types::{HandlerError, HandlerRequest, HandlerResponse, Result};
use crate::upstream::UpstreamRequest;
use sci_anonymizer::{Entity, TokenMap, anonymize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub async fn handle_openai_chat(
    req:   HandlerRequest,
    state: Arc<HandlerState>,
) -> Result<HandlerResponse> {
    // ── 1. Parse + anonymize ───────────────────────────────────────────────
    let mut body: Value = serde_json::from_slice(&req.body)
        .map_err(|e| HandlerError::Malformed(format!("body JSON: {e}")))?;

    let mut session_map = TokenMap::default();
    let entities        = anonymize_messages_body(&mut body, &mut session_map)?;
    let masked_count    = entities.len() as u32;

    // ── 2. Memory recall + injection ───────────────────────────────────────
    let recall_seed = extract_recall_seed(&body);
    let _ = inject_memory_context(&mut body, &recall_seed, &state).await;

    // ── 3. Build upstream request ──────────────────────────────────────────
    let upstream_url     = format!("https://{}{}", req.hostname, req.url);
    let upstream_body    = serde_json::to_vec(&body)
        .map_err(|e| HandlerError::Malformed(format!("re-serialize body: {e}")))?;
    let upstream_headers = build_upstream_headers(&req)?;

    let upstream_req = UpstreamRequest {
        method:  "POST".into(),
        url:     upstream_url,
        headers: upstream_headers,
        body:    upstream_body.into(),
    };

    // ── 4. Forward ─────────────────────────────────────────────────────────
    let upstream_resp = state.upstream.send(upstream_req).await
        .map_err(|e| HandlerError::Upstream(e.to_string()))?;

    if !(200..300).contains(&upstream_resp.status) {
        let mut headers = upstream_resp.headers;
        headers.insert("x-sci-masked".into(), masked_count.to_string());
        return Ok(HandlerResponse::streaming(
            upstream_resp.status,
            headers,
            upstream_resp.body,
        ));
    }

    // ── 5. Deanonymize the streaming response ──────────────────────────────
    // The shared `DeanonymizingStream` recognizes both Anthropic and
    // OpenAI event shapes (matched by JSON shape, not by URL/host),
    // so the same struct handles both providers without branching.
    let de = DeanonymizingStream::new();
    let wrapped_body = de.wrap(upstream_resp.body, session_map);

    let mut headers = upstream_resp.headers;
    headers.insert("x-sci-masked".into(), masked_count.to_string());

    // SCI-138 inspector: OpenAI handler doesn't yet populate the
    // post-anonymize / pre-deanon snapshots — Anthropic gets them
    // because that's the active dogfood path. Adding here is a small
    // follow-up: copy the body bytes before forwarding (request) and
    // wrap the stream with a tee-buffer to capture the response.
    Ok(HandlerResponse::streaming(
        upstream_resp.status,
        headers,
        wrapped_body,
    ))
}

// ── Body anonymization ─────────────────────────────────────────────────────

/// Walk an OpenAI `/v1/chat/completions` request body and anonymize
/// every piece of user-visible text. Mutates the JSON in place.
///
/// OpenAI accepts `messages[*].content` as either a string OR an array
/// of typed content parts (`{type: "text", text: "…"}`,
/// `{type: "image_url", …}` etc.). We touch only the `text` parts,
/// matching what the Anthropic handler does for its content blocks.
/// See anthropic.rs for rationale. Shared constant intentionally
/// duplicated to avoid a cross-crate dep for a single scalar.
const ANON_CIRCUIT_BREAKER: usize = 25;

fn anonymize_messages_body(body: &mut Value, map: &mut TokenMap) -> Result<Vec<Entity>> {
    let mut all_entities = Vec::new();

    let pre_anon_snapshot = body
        .get("messages")
        .cloned()
        .unwrap_or(Value::Array(vec![]));

    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return Ok(all_entities);
    };
    for message in messages {
        // SCI-199: skip assistant-role messages. Assistant prior turns
        // are already deanonymized plain-English in history; re-anonymizing
        // creates a vocab-feedback loop where the model learns that
        // [PLACE_N] is an English word. User + system messages anonymize normally.
        if message.get("role").and_then(|v| v.as_str()) == Some("assistant") {
            continue;
        }
        let Some(content) = message.get_mut("content") else { continue; };
        match content {
            Value::String(_) => anonymize_in_place(content, map, &mut all_entities),
            Value::Array(parts) => {
                for part in parts {
                    let part_type = part
                        .get("type")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    if part_type.as_deref() == Some("text")
                        && let Some(text) = part.get_mut("text")
                    {
                        anonymize_in_place(text, map, &mut all_entities);
                    }
                }
            }
            _ => {}
        }
    }

    if all_entities.len() > ANON_CIRCUIT_BREAKER {
        tracing::warn!(
            target: "sci_handlers::anonymizer",
            entity_count = all_entities.len(),
            threshold    = ANON_CIRCUIT_BREAKER,
            "circuit breaker fired: too many masked entities; \
             rolling back substitutions and passing request through unmasked."
        );
        if let Some(msgs) = body.get_mut("messages") {
            *msgs = pre_anon_snapshot;
        }
        *map = TokenMap::default();
        return Ok(Vec::new());
    }

    Ok(all_entities)
}

fn anonymize_in_place(node: &mut Value, map: &mut TokenMap, out_entities: &mut Vec<Entity>) {
    let Some(s) = node.as_str() else { return; };
    let result = anonymize(s, Some(std::mem::take(map)));
    *map = result.token_map;
    out_entities.extend(result.detected);
    *node = Value::String(result.text);
}

// ── Memory recall + injection ──────────────────────────────────────────────

/// Pull the most recent user message text out of the (already-
/// anonymized) body.
fn extract_recall_seed(body: &Value) -> String {
    let Some(messages) = body.get("messages").and_then(|v| v.as_array()) else {
        return String::new();
    };
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("user") { continue; }
        let content = msg.get("content");
        if let Some(s) = content.and_then(|v| v.as_str()) { return s.to_string(); }
        if let Some(arr) = content.and_then(|v| v.as_array()) {
            for part in arr {
                if part.get("type").and_then(|v| v.as_str()) == Some("text")
                    && let Some(t) = part.get("text").and_then(|v| v.as_str())
                {
                    return t.to_string();
                }
            }
        }
    }
    String::new()
}

/// Recall + inject. Same logic as the Anthropic handler — prepend a
/// memory prefix to the system message (or insert a system message at
/// the front of `messages` if none exists, since OpenAI doesn't have
/// a top-level `system` field). Mirrors the TS proxy's
/// `injectMemoryContext` for OpenRouter / OpenAI requests.
async fn inject_memory_context(
    body:  &mut Value,
    seed:  &str,
    state: &Arc<HandlerState>,
) -> Result<()> {
    if seed.is_empty() { return Ok(()); }

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
            query_embedding: &query_emb,
            query:           seed,
            profile_id:      &profile_id,
            limit:           5,
            types:           &[],
        })?
    };

    if hits.is_empty() { return Ok(()); }

    let mut prefix = String::from(
        "You have memory of previous interactions. Here are relevant memories:\n\n",
    );
    for h in &hits {
        prefix.push_str("- ");
        prefix.push_str(&h.content);
        prefix.push('\n');
    }
    prefix.push('\n');

    // OpenAI carries the system message inside `messages[0]` when role
    // == "system". Prepend if not present; otherwise prefix the
    // existing one.
    let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return Ok(());
    };
    let has_system_first = messages
        .first()
        .and_then(|m| m.get("role"))
        .and_then(|v| v.as_str())
        == Some("system");
    if has_system_first {
        if let Some(content) = messages[0].get_mut("content") {
            match content {
                Value::String(s) => { *s = format!("{prefix}{s}"); }
                Value::Array(parts) => {
                    // OpenAI 4o-class system messages can be array-shaped
                    // (rare). Find the first text part and prepend.
                    for part in parts {
                        if part.get("type").and_then(|v| v.as_str()) == Some("text")
                            && let Some(t) = part.get_mut("text").and_then(|v| v.as_str().map(String::from))
                        {
                            part["text"] = Value::String(format!("{prefix}{t}"));
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
    } else {
        // Insert a fresh system message at the front.
        let sys = serde_json::json!({
            "role":    "system",
            "content": prefix,
        });
        messages.insert(0, sys);
    }
    Ok(())
}

// ── Outbound headers ───────────────────────────────────────────────────────

/// Forward the auth header + content-type; strip hop-by-hop. OpenAI
/// uses `Authorization: Bearer …` (not `x-api-key`); the credential
/// injector should already have stamped one. We accept either header
/// at parse time and emit `Authorization: Bearer …` upstream.
fn build_upstream_headers(req: &HandlerRequest) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();

    let auth = req.header("authorization").map(str::to_string);
    let api_key = req.header("x-api-key").map(str::to_string);
    let bearer = match (auth, api_key) {
        (Some(a), _) if a.starts_with("Bearer ") => a,
        (Some(a), _) if !a.is_empty() => format!("Bearer {a}"),
        (_, Some(k)) if !k.is_empty() => format!("Bearer {k}"),
        _ => {
            return Err(HandlerError::MissingCredential {
                header: "authorization",
            });
        }
    };
    out.insert("authorization".into(), bearer);

    out.insert("content-type".into(), "application/json".into());
    out.insert("accept".into(), "text/event-stream, application/json".into());
    Ok(out)
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
        assert!(
            masked_content.contains("[URL_"),
            "expected token, got: {masked_content}",
        );
    }

    #[test]
    fn anonymize_array_content_parts() {
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":[
                {"type":"text","text":"see openclaw.dev for details"},
                {"type":"image_url","image_url":{"url":"https://example.com/x.png"}}
              ]}]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut body, &mut map).unwrap();
        let masked = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(masked.contains("[URL_"));
        // image_url part untouched.
        assert_eq!(
            body["messages"][0]["content"][1]["image_url"]["url"].as_str(),
            Some("https://example.com/x.png"),
        );
    }

    #[test]
    fn assistant_role_not_anonymized_sci199() {
        // SCI-199: assistant prior turns must NOT be re-anonymized.
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[
                {"role":"user","content":"hi I'm Casey from openclaw.dev"},
                {"role":"assistant","content":"Hi Casey! What can I help with?"},
                {"role":"user","content":"continue"}
            ]}"#,
        )
        .unwrap();
        let mut map = TokenMap::default();
        let _ = anonymize_messages_body(&mut body, &mut map).unwrap();
        // Assistant message must be byte-identical to input.
        let assistant = body["messages"][1]["content"].as_str().unwrap();
        assert_eq!(
            assistant, "Hi Casey! What can I help with?",
            "assistant content must pass through unchanged (SCI-199): {assistant}",
        );
        // User messages still anonymized normally.
        let user = body["messages"][0]["content"].as_str().unwrap();
        assert!(
            user.contains("[PERSON_") || user.contains("[URL_"),
            "user content must still be anonymized: {user}",
        );
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

    #[test]
    fn extract_recall_seed_array_content() {
        let body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":[
                {"type":"image_url","image_url":{"url":"x"}},
                {"type":"text","text":"explain this image"}
            ]}]}"#,
        )
        .unwrap();
        assert_eq!(extract_recall_seed(&body), "explain this image");
    }

    #[test]
    fn build_upstream_headers_uses_authorization() {
        let mut headers = HashMap::new();
        headers.insert("authorization".into(), "Bearer sk-real".into());
        let req = HandlerRequest {
            method:   "POST".into(),
            url:      "/v1/chat/completions".into(),
            headers,
            body:     bytes::Bytes::new(),
            hostname: "api.openai.com".into(),
        };
        let out = build_upstream_headers(&req).unwrap();
        assert_eq!(out.get("authorization"), Some(&"Bearer sk-real".to_string()));
    }

    #[test]
    fn build_upstream_headers_promotes_x_api_key() {
        // OpenRouter docs accept either header but standardize on
        // Authorization. If the client sent x-api-key, we promote it
        // to a Bearer.
        let mut headers = HashMap::new();
        headers.insert("x-api-key".into(), "sk-xx".into());
        let req = HandlerRequest {
            method:   "POST".into(),
            url:      "/v1/chat/completions".into(),
            headers,
            body:     bytes::Bytes::new(),
            hostname: "openrouter.ai".into(),
        };
        let out = build_upstream_headers(&req).unwrap();
        assert_eq!(out.get("authorization"), Some(&"Bearer sk-xx".to_string()));
    }

    #[test]
    fn build_upstream_headers_errors_on_no_credential() {
        let req = HandlerRequest {
            method:   "POST".into(),
            url:      "/v1/chat/completions".into(),
            headers:  HashMap::new(),
            body:     bytes::Bytes::new(),
            hostname: "api.openai.com".into(),
        };
        let err = build_upstream_headers(&req).unwrap_err();
        assert!(matches!(err, HandlerError::MissingCredential { .. }));
    }

    #[test]
    fn inject_memory_context_prepends_system_message() {
        // Just exercises the "no system message → insert one" branch.
        // Real recall test lives in sci-memory; here we just verify
        // the JSON shaping doesn't drop messages.
        let mut body: Value = serde_json::from_str(
            r#"{"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        // Manually call the injection-prefix logic. inject_memory_context
        // requires a real HandlerState; the JSON shape part is the bit
        // we test here.
        let prefix = String::from("MEM:\n- foo\n\n");
        let messages = body.get_mut("messages").and_then(|v| v.as_array_mut()).unwrap();
        let has_system = messages
            .first()
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            == Some("system");
        assert!(!has_system);
        messages.insert(0, serde_json::json!({"role":"system","content":prefix.clone()}));
        assert_eq!(body["messages"][0]["role"].as_str(), Some("system"));
        assert_eq!(body["messages"][1]["role"].as_str(), Some("user"));
    }
}
