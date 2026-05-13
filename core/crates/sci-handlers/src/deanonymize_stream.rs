//! SSE-aware deanonymization stream.
//!
//! Anthropic's `/v1/messages` returns Server-Sent Events. Each event
//! looks like:
//!
//! ```text
//! event: content_block_delta
//! data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
//!
//! ```
//!
//! Events are separated by `\n\n`. We can't naively `String::replace`
//! the raw bytestream because tokens like `[PERSON_1]` could span
//! chunk boundaries — a chunk ending in `[PERS` followed by `ON_1]…`
//! would slip through. Instead we buffer bytes, peel off complete SSE
//! events as they arrive, JSON-parse each event's `data` payload,
//! swap tokens inside the `text_delta.text` field, re-serialize, and
//! emit downstream.
//!
//! Non-`content_block_delta` events pass through unchanged.
//!
//! `fullResponse` (the deanonymized concatenated text used by
//! `storeInteraction` in TS) is exposed via
//! `DeanonymizingStream::full_response` after the upstream stream
//! ends. Tests and the `storeInteraction` path consume that.

use crate::types::BodyStream;
use bytes::Bytes;
use futures::StreamExt;
use sci_anonymizer::{TokenMap, deanonymize};
use std::sync::{Arc, Mutex};

/// Wrap an upstream SSE stream + token map. Returns a new stream that
/// emits the same events with tokens swapped, plus a handle to read
/// the accumulated deanonymized text after the stream ends.
pub struct DeanonymizingStream {
    /// The deanonymized concatenation of every text-delta we've seen.
    /// Available after `wrap()`'s stream ends; read by the storage
    /// path so we can persist what the user actually saw.
    pub full_response: Arc<Mutex<String>>,
    /// Prompt-cache usage extracted from the `message_start` SSE event.
    /// Populated once per stream; `None` until `message_start` is seen.
    pub cache_metrics: Arc<Mutex<Option<CacheMetrics>>>,
}

/// Token-usage breakdown returned by Anthropic in the `message_start` event.
#[derive(Debug, Clone, Default)]
pub struct CacheMetrics {
    pub input_tokens:            u64,
    pub cache_creation_tokens:   u64,
    pub cache_read_tokens:       u64,
    pub output_tokens:           u64,  // filled from message_delta
}

impl DeanonymizingStream {
    pub fn new() -> Self {
        Self {
            full_response: Arc::new(Mutex::new(String::new())),
            cache_metrics: Arc::new(Mutex::new(None)),
        }
    }

    /// Wrap an upstream `BodyStream` so its bytes are deanonymized in
    /// flight. The returned stream owns the buffer + map so it can run
    /// independently of the caller; `full_response` is shared via the
    /// inner `Arc<Mutex>` so the caller can read it after the stream
    /// terminates.
    pub fn wrap(&self, upstream: BodyStream, token_map: TokenMap) -> BodyStream {
        self.wrap_inner(upstream, token_map, None)
    }

    /// Like `wrap`, but invokes `on_complete(full_deanonymized_text)`
    /// exactly once after the upstream stream finishes (either via
    /// natural EOF or after a tail-buffer flush). The callback runs
    /// inline on the stream's task — keep it cheap; spawn anything
    /// slow (DB writes, embeddings) onto its own task.
    ///
    /// This is the flight-recorder hook: the callback receives the
    /// fully assembled, deanonymized assistant text and can persist
    /// it (audit_turns row, episodic memory, SCI-138 event emission,
    /// etc.) without bloating the streaming hot path.
    ///
    /// The callback is NOT invoked if the stream errors out partway —
    /// in that case `full_response` may still hold a partial transcript
    /// that the caller can inspect via the `full_response` Arc.
    pub fn wrap_with_finalize<F>(
        &self,
        upstream:    BodyStream,
        token_map:   TokenMap,
        on_complete: F,
    ) -> BodyStream
    where
        F: FnOnce(String) + Send + 'static,
    {
        self.wrap_inner(upstream, token_map, Some(Box::new(on_complete)))
    }

    fn wrap_inner(
        &self,
        upstream:    BodyStream,
        token_map:   TokenMap,
        on_complete: Option<Box<dyn FnOnce(String) + Send + 'static>>,
    ) -> BodyStream {
        let full    = self.full_response.clone();
        let metrics = self.cache_metrics.clone();
        let mut buf: Vec<u8> = Vec::new();
        let mut upstream = upstream;
        let mut on_complete = on_complete;

        // `async_stream::stream!` builds an `impl Stream<Item = ...>`
        // from imperative async code. State (buf, full, token_map,
        // on_complete) lives across yield points cleanly.
        let stream = async_stream::stream! {
            while let Some(chunk) = upstream.next().await {
                let chunk = match chunk {
                    Ok(b)  => b,
                    Err(e) => { yield Err(e); return; }
                };
                buf.extend_from_slice(&chunk);

                // Peel off complete SSE events — each one is a
                // CRLF/LF-terminated block ending in a blank line.
                // We accept either `\n\n` (UNIX) or `\r\n\r\n` (HTTP)
                // because some upstreams switch between them.
                while let Some(end) = find_event_boundary(&buf) {
                    let event_bytes: Vec<u8> = buf.drain(..end).collect();
                    let processed =
                        process_event(&event_bytes, &token_map, &full, &metrics);
                    yield Ok(Bytes::from(processed));
                }
            }
            // Drain whatever's left in the buffer at EOF — shouldn't
            // be a partial event in practice, but if it is we emit
            // it unchanged so the client sees something rather than
            // truncating.
            if !buf.is_empty() {
                yield Ok(Bytes::from(buf));
            }

            // Finalize: read the accumulated deanonymized text and
            // hand it to the caller's flight-recorder hook. Done
            // AFTER yielding the tail buffer so the client sees the
            // whole transcript before storage fires (matches user
            // expectation: "the answer arrives, then it's logged").
            if let Some(cb) = on_complete.take() {
                let text = full.lock()
                    .map(|s| s.clone())
                    .unwrap_or_default();
                cb(text);
            }
        };
        Box::pin(stream)
    }
}

impl Default for DeanonymizingStream {
    fn default() -> Self { Self::new() }
}

/// Locate the byte offset just past the next SSE event terminator.
/// Returns `None` if the buffer doesn't yet contain a complete event.
fn find_event_boundary(buf: &[u8]) -> Option<usize> {
    // Two consecutive newlines mark end of event. Check `\r\n\r\n`
    // first (HTTP standard), fall back to `\n\n`.
    if let Some(i) = find_subseq(buf, b"\r\n\r\n") { return Some(i + 4); }
    if let Some(i) = find_subseq(buf, b"\n\n")     { return Some(i + 2); }
    None
}

fn find_subseq(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Process a single SSE event: if its `data:` payload is a
/// content_block_delta with a text_delta, deanonymize the text and
/// re-serialize. Otherwise pass through unchanged. Returns bytes
/// suitable for direct emission downstream (event frame intact,
/// trailing blank line preserved).
fn process_event(
    raw:        &[u8],
    token_map:  &TokenMap,
    full_resp:  &Arc<Mutex<String>>,
    cache_arc:  &Arc<Mutex<Option<CacheMetrics>>>,
) -> Vec<u8> {
    let text = match std::str::from_utf8(raw) {
        Ok(s)  => s,
        Err(_) => return raw.to_vec(),  // binary somewhere — pass through
    };

    // Each line starts with a field name. We only look at `data:`
    // lines; everything else (event:, id:, retry:) carries no payload
    // we modify.
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let stripped = line.trim_end_matches(['\r', '\n']);
        if let Some(json_str) = stripped.strip_prefix("data: ") {
            // JSON-parse, modify, re-serialize. If parsing fails
            // (unexpected upstream shape) we leave the line alone —
            // better to emit something the client can still display
            // than to drop the event.
            match serde_json::from_str::<serde_json::Value>(json_str) {
                Ok(mut value) => {
                    extract_cache_metrics(&value, cache_arc);
                    deanonymize_text_delta(&mut value, token_map, full_resp);
                    out.push_str("data: ");
                    out.push_str(&value.to_string());
                    // Preserve original line ending (\n or \r\n).
                    if line.ends_with("\r\n") {
                        out.push_str("\r\n");
                    } else if line.ends_with('\n') {
                        out.push('\n');
                    }
                }
                Err(_) => out.push_str(line),
            }
        } else {
            out.push_str(line);
        }
    }
    out.into_bytes()
}

/// Extract Anthropic prompt-cache usage from `message_start` and
/// output token count from `message_delta` events.
///
/// Anthropic sends these two events during every SSE stream:
///
///   `message_start`:  usage.input_tokens, usage.cache_creation_input_tokens,
///                     usage.cache_read_input_tokens
///   `message_delta`:  usage.output_tokens
///
/// We accumulate into a shared `CacheMetrics` so the finalize callback
/// can persist them alongside the audit_turn row.
fn extract_cache_metrics(value: &serde_json::Value, arc: &Arc<Mutex<Option<CacheMetrics>>>) {
    let Some(obj) = value.as_object() else { return; };
    let event_type = obj.get("type").and_then(|v| v.as_str());

    match event_type {
        Some("message_start") => {
            let usage = obj
                .get("message").and_then(|m| m.get("usage"));
            if let Some(u) = usage {
                let get = |key: &str| u.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
                let m = CacheMetrics {
                    input_tokens:          get("input_tokens"),
                    cache_creation_tokens: get("cache_creation_input_tokens"),
                    cache_read_tokens:     get("cache_read_input_tokens"),
                    output_tokens:         0, // filled below
                };
                if let Ok(mut guard) = arc.lock() {
                    *guard = Some(m);
                }
            }
        }
        Some("message_delta") => {
            let out = obj.get("usage")
                .and_then(|u| u.get("output_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if out > 0 {
                if let Ok(mut guard) = arc.lock() {
                    if let Some(ref mut m) = *guard {
                        m.output_tokens = out;
                    }
                }
            }
        }
        _ => {}
    }
}

/// In-place edit: deanonymize whichever provider-specific text-delta
/// shape the event matches. Currently handles:
///
///   - **Anthropic** `/v1/messages` SSE:
///     `{type: "content_block_delta", delta: {type: "text_delta", text: "…"}}`
///   - **OpenAI** `/v1/chat/completions` SSE (and OpenAI-compatible
///     providers like OpenRouter):
///     `{object: "chat.completion.chunk", choices: [{delta: {content: "…"}}]}`
///
/// Adding Gemini's shape lands as a third match arm; the surrounding
/// stream plumbing stays unchanged. Track the deanonymized fragment
/// in `full_response` so the storeInteraction path can persist what
/// the user actually saw.
fn deanonymize_text_delta(
    value:     &mut serde_json::Value,
    token_map: &TokenMap,
    full_resp: &Arc<Mutex<String>>,
) {
    let Some(obj) = value.as_object_mut() else { return; };

    // ── Anthropic: content_block_delta → delta.text_delta → text ────────
    let event_type = obj.get("type").and_then(|v| v.as_str());
    if event_type == Some("content_block_delta") {
        if let Some(delta) = obj.get_mut("delta").and_then(|v| v.as_object_mut()) {
            let delta_type = delta.get("type").and_then(|v| v.as_str()).map(str::to_owned);
            match delta_type.as_deref() {
                Some("text_delta") => {
                    if let Some(text_v) = delta.get_mut("text")
                        && let Some(orig) = text_v.as_str()
                    {
                        let swapped = deanonymize(orig, token_map);
                        if let Ok(mut s) = full_resp.lock() {
                            s.push_str(&swapped);
                        }
                        *text_v = serde_json::Value::String(swapped);
                    }
                }
                // Tool-use input streams as `input_json_delta` chunks. The
                // Write tool's `content` parameter (file body), the Bash
                // tool's `command` (shell string), etc. all flow through
                // here. Without this branch, masked tokens reach the client
                // verbatim and get persisted to disk via the tool — which
                // is how Casey's `~/.claude/projects/.../user_profile.md`
                // ended up with `[PLACE_4] [PLACE_5]` baked in.
                //
                // Caveat: `partial_json` is a streamed JSON-string fragment.
                // A masked token split exactly across two chunks (rare —
                // chunks are typically much larger than a 10-char token)
                // would miss this scan. Acceptable for v0.5; a chunk-
                // buffering deanonymizer is the polish.
                Some("input_json_delta") => {
                    if let Some(pj_v) = delta.get_mut("partial_json")
                        && let Some(orig) = pj_v.as_str()
                    {
                        let swapped = deanonymize(orig, token_map);
                        // Don't accumulate tool-use payloads into
                        // `full_resp` — that's only for user-visible
                        // assistant text, used by the storage path.
                        *pj_v = serde_json::Value::String(swapped);
                    }
                }
                _ => {}
            }
        }
        return;
    }

    // ── Anthropic: content_block_start → content_block.{input | text} ────
    // The `content_block_start` event for a `tool_use` block carries the
    // initial `input` field, which can already contain masked tokens if
    // it's small enough to fit in the first chunk. Walk the input JSON
    // and replace tokens in any string leaf.
    if event_type == Some("content_block_start") {
        if let Some(cb) = obj.get_mut("content_block").and_then(|v| v.as_object_mut()) {
            let cb_type = cb.get("type").and_then(|v| v.as_str()).map(str::to_owned);
            match cb_type.as_deref() {
                Some("tool_use") => {
                    if let Some(input) = cb.get_mut("input") {
                        deanonymize_json_recursive(input, token_map);
                    }
                }
                Some("text") => {
                    if let Some(text_v) = cb.get_mut("text")
                        && let Some(orig) = text_v.as_str()
                    {
                        let swapped = deanonymize(orig, token_map);
                        if let Ok(mut s) = full_resp.lock() {
                            s.push_str(&swapped);
                        }
                        *text_v = serde_json::Value::String(swapped);
                    }
                }
                _ => {}
            }
        }
        return;
    }

    // ── OpenAI: choices[*].delta.content ────────────────────────────────
    // Match by `object: "chat.completion.chunk"` to avoid touching
    // anything that isn't an OpenAI streaming chunk.
    let object = obj.get("object").and_then(|v| v.as_str());
    if object == Some("chat.completion.chunk")
        && let Some(choices) = obj.get_mut("choices").and_then(|v| v.as_array_mut())
    {
        for choice in choices {
            let Some(c) = choice.as_object_mut() else { continue; };
            let Some(delta) = c.get_mut("delta").and_then(|v| v.as_object_mut())
                else { continue; };
            let Some(content) = delta.get_mut("content") else { continue; };
            let Some(orig)    = content.as_str() else { continue; };
            let swapped = deanonymize(orig, token_map);
            if let Ok(mut s) = full_resp.lock() {
                s.push_str(&swapped);
            }
            *content = serde_json::Value::String(swapped);
        }
        return;
    }

    // ── Gemini: candidates[*].content.parts[*].text ─────────────────────
    // Detection by structure rather than a sentinel object/type field —
    // Gemini chunks don't carry a discriminator the way Anthropic and
    // OpenAI do. The presence of `candidates: [...]` with at least one
    // entry having `content.parts` is the marker.
    if let Some(candidates) = obj.get_mut("candidates").and_then(|v| v.as_array_mut()) {
        for candidate in candidates {
            let Some(cand) = candidate.as_object_mut() else { continue; };
            let Some(content) = cand.get_mut("content").and_then(|v| v.as_object_mut())
                else { continue; };
            let Some(parts) = content.get_mut("parts").and_then(|v| v.as_array_mut())
                else { continue; };
            for part in parts {
                let Some(p) = part.as_object_mut() else { continue; };
                let Some(text_v) = p.get_mut("text") else { continue; };
                let Some(orig)   = text_v.as_str() else { continue; };
                let swapped = deanonymize(orig, token_map);
                if let Ok(mut s) = full_resp.lock() {
                    s.push_str(&swapped);
                }
                *text_v = serde_json::Value::String(swapped);
            }
        }
    }
}

/// Walk a JSON value and run `deanonymize` on every string leaf,
/// in place. Used for tool-use `input` payloads in
/// `content_block_start` events — the input is an arbitrary
/// JSON object (Write/Bash/Edit/etc. tool args) so we can't
/// assume any specific shape.
fn deanonymize_json_recursive(value: &mut serde_json::Value, token_map: &TokenMap) {
    match value {
        serde_json::Value::String(s) => {
            *s = deanonymize(s, token_map);
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                deanonymize_json_recursive(v, token_map);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                deanonymize_json_recursive(v, token_map);
            }
        }
        _ => {} // numbers / bools / null — no PII to swap
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sci_anonymizer::anonymize;
    use futures::stream;
    use futures::StreamExt;

    fn collect_bytes(stream: BodyStream) -> Vec<u8> {
        // Run a tiny tokio runtime to drain the stream synchronously
        // for the test assertion.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let mut s = stream;
            let mut out = Vec::new();
            while let Some(chunk) = s.next().await {
                out.extend_from_slice(&chunk.unwrap());
            }
            out
        })
    }

    #[test]
    fn passes_through_unchanged_when_no_tokens_in_text() {
        // Anonymize an empty string — produces an empty token map.
        // The wrapper should be a no-op, just buffering through.
        let map = anonymize("", None).token_map;
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from_static(
                b"event: ping\ndata: {\"type\":\"ping\"}\n\n",
            )),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, map));
        assert!(std::str::from_utf8(&out).unwrap().contains("\"type\":\"ping\""));
    }

    #[test]
    fn deanonymizes_text_delta_token() {
        // Build a token map by anonymizing a prompt that contains
        // `OpenClaw` (CamelCase → PROJECT_1).
        let r = anonymize("OpenClaw is shipping", None);
        let token_for_openclaw = r.token_map.forward.get("OpenClaw").unwrap().clone();

        // Synthesize an Anthropic SSE event that contains the token in
        // a text_delta — this is what the upstream would emit if it
        // saw the masked prompt and replied "yes [PROJECT_1] is good."
        let event = format!(
            "event: content_block_delta\n\
             data: {{\"type\":\"content_block_delta\",\"index\":0,\
             \"delta\":{{\"type\":\"text_delta\",\"text\":\"yes {token} is good\"}}}}\n\n",
            token = token_for_openclaw,
        );
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(event.into_bytes())),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, r.token_map));
        let text = std::str::from_utf8(&out).unwrap();
        assert!(text.contains("yes OpenClaw is good"),
            "expected deanonymized text in event, got: {text}");
        assert!(!text.contains(&token_for_openclaw),
            "token leaked through: {text}");
        // full_response captured the swapped text.
        assert_eq!(*de.full_response.lock().unwrap(), "yes OpenClaw is good");
    }

    #[test]
    fn handles_event_boundary_split_across_chunks() {
        // Same event as above, but split into two chunks at an
        // arbitrary offset to exercise the buffer logic.
        let r = anonymize("OpenClaw", None);
        let token = r.token_map.forward.get("OpenClaw").unwrap().clone();
        let event = format!(
            "event: content_block_delta\n\
             data: {{\"type\":\"content_block_delta\",\"index\":0,\
             \"delta\":{{\"type\":\"text_delta\",\"text\":\"hi {token}!\"}}}}\n\n",
        );
        let bytes = event.into_bytes();
        let mid = bytes.len() / 2;
        let (a, b) = bytes.split_at(mid);

        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::copy_from_slice(a)),
            Ok::<_, std::io::Error>(Bytes::copy_from_slice(b)),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, r.token_map));
        let text = std::str::from_utf8(&out).unwrap();
        assert!(text.contains("hi OpenClaw!"), "got: {text}");
    }

    #[test]
    fn non_content_block_delta_events_pass_through() {
        // message_start, message_stop, etc. shouldn't be modified —
        // they don't contain user-visible text.
        let r = anonymize("OpenClaw", None);
        let event = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from_static(event.as_bytes())),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, r.token_map));
        let text = std::str::from_utf8(&out).unwrap();
        assert_eq!(text.trim(), event.trim());
    }

    /// Regression: when Claude uses a tool (e.g. Write to save a memory
    /// file), the tool's `input` arguments stream through `input_json_delta`
    /// SSE events. Before the fix, masked tokens reached the client
    /// verbatim — and Casey's `~/.claude/projects/.../user_profile.md`
    /// got `[PLACE_4] [PLACE_5]` baked in by Claude Code's Write tool.
    /// This test pins the fix.
    #[test]
    fn deanonymizes_input_json_delta() {
        let r = anonymize("OpenClaw", None);
        let token = r.token_map.forward.get("OpenClaw").unwrap().clone();

        // Mimic the Write tool's input streaming through:
        //   {"file_path":"...", "content":"<token>"}
        let event = format!(
            "event: content_block_delta\n\
             data: {{\"type\":\"content_block_delta\",\"index\":1,\
             \"delta\":{{\"type\":\"input_json_delta\",\
             \"partial_json\":\"{{\\\"content\\\":\\\"hello {token}\\\"}}\"}}}}\n\n",
        );
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(event.into_bytes())),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, r.token_map));
        let text = std::str::from_utf8(&out).unwrap();
        assert!(
            text.contains("hello OpenClaw"),
            "input_json_delta deanon failed; got: {text}",
        );
        assert!(!text.contains(&token), "token leaked in tool input: {text}");
    }

    /// Flight-recorder hook: `wrap_with_finalize` invokes the callback
    /// exactly once after the upstream stream ends, with the full
    /// deanonymized assistant text. Pins the contract that downstream
    /// consumers (audit_turns writer, SCI-138 emitter) can rely on
    /// receiving the assembled transcript without polling
    /// `full_response` themselves.
    #[test]
    fn finalize_callback_fires_with_deanonymized_text() {
        let r = anonymize("OpenClaw is shipping", None);
        let token = r.token_map.forward.get("OpenClaw").unwrap().clone();
        let event = format!(
            "event: content_block_delta\n\
             data: {{\"type\":\"content_block_delta\",\"index\":0,\
             \"delta\":{{\"type\":\"text_delta\",\"text\":\"shipping {token} v2\"}}}}\n\n",
        );
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(event.into_bytes())),
        ]));

        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let captured_for_cb = captured.clone();
        let de = DeanonymizingStream::new();
        let stream = de.wrap_with_finalize(upstream, r.token_map, move |text| {
            *captured_for_cb.lock().unwrap() = Some(text);
        });
        let _ = collect_bytes(stream);

        let got = captured.lock().unwrap().clone();
        assert_eq!(got.as_deref(), Some("shipping OpenClaw v2"));
    }

    /// `content_block_start` for a `tool_use` block carries the initial
    /// `input` object. Small tool inputs may be fully present in the
    /// start event (no following delta chunks needed). Cover that path.
    #[test]
    fn deanonymizes_tool_use_content_block_start_input() {
        let r = anonymize("OpenClaw", None);
        let token = r.token_map.forward.get("OpenClaw").unwrap().clone();

        let event = format!(
            "event: content_block_start\n\
             data: {{\"type\":\"content_block_start\",\"index\":1,\
             \"content_block\":{{\"type\":\"tool_use\",\"id\":\"toolu_x\",\
             \"name\":\"Write\",\"input\":{{\
             \"file_path\":\"/tmp/note.md\",\
             \"content\":\"based at {token}\"}}}}}}\n\n",
        );
        let upstream: BodyStream = Box::pin(stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(event.into_bytes())),
        ]));
        let de = DeanonymizingStream::new();
        let out = collect_bytes(de.wrap(upstream, r.token_map));
        let text = std::str::from_utf8(&out).unwrap();
        assert!(
            text.contains("based at OpenClaw"),
            "tool_use input deanon failed; got: {text}",
        );
        assert!(!text.contains(&token), "token leaked: {text}");
    }
}
