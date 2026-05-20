//! Hostname × path × method → handler lookup.
//!
//! Mirrors `pickHandler` in `packages/agent/src/proxy-server.ts`. The
//! dispatch decision is intentionally pulled into one function so the
//! AI-host whitelist + the path-pattern rules per provider live in
//! one readable place.
//!
//! Returning `None` means "we don't anonymize this — the platform
//! shell should pass through unchanged." That's important for
//! auxiliary calls some tools make to AI hosts (event logging, file
//! uploads) that share the host but aren't the prompt path.

use crate::anthropic::handle_anthropic_messages;
use crate::google::handle_google_gemini;
use crate::openai::handle_openai_chat;
use crate::state::HandlerState;
use crate::types::{HandlerRequest, HandlerResponse, Result};
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

static ANTHROPIC_HOSTS: Lazy<HashSet<&'static str>> =
    Lazy::new(|| ["api.anthropic.com"].into_iter().collect());

static OPENAI_HOSTS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    // `openrouter.ai` shares OpenAI's request shape; same handler,
    // different upstream. Keeping both in this set + branching inside
    // the handler is simpler than two near-identical handlers.
    ["api.openai.com", "openrouter.ai"].into_iter().collect()
});

static GOOGLE_HOSTS: Lazy<HashSet<&'static str>> =
    Lazy::new(|| ["generativelanguage.googleapis.com"].into_iter().collect());

/// Boxed async handler signature. Returned by `pick_handler` so the
/// caller can `.await` whichever provider matched.
pub type Handler = Box<
    dyn FnOnce(
            HandlerRequest,
            Arc<HandlerState>,
        ) -> Pin<Box<dyn Future<Output = Result<HandlerResponse>> + Send>>
        + Send,
>;

/// True iff `hostname` is one Sci has handlers for. The proxy
/// (SCI-148) uses this BEFORE TLS termination to decide whether to
/// MITM the connection or run a plain CONNECT tunnel: hosts we don't
/// recognize get tunneled byte-for-byte without inspection.
///
/// This is the right behavior for a transparent proxy. Without it,
/// Claude Code (which talks to `downloads.claude.ai` for update
/// checks, `http-intake.logs.us5.datadoghq.com` for telemetry, etc.)
/// would have all that traffic broken because Sci would intercept it
/// and have no handler. With it, only AI inference traffic goes
/// through the masking pipeline; everything else is invisible to Sci.
pub fn is_intercepted_host(hostname: &str) -> bool {
    let host = hostname.to_lowercase();
    ANTHROPIC_HOSTS.contains(host.as_str())
        || OPENAI_HOSTS.contains(host.as_str())
        || GOOGLE_HOSTS.contains(host.as_str())
}

/// Match a request against the AI-host routing table. Returns `None`
/// for non-matches so the shell can passthrough.
pub fn pick_handler(req: &HandlerRequest) -> Option<Handler> {
    if req.method.eq_ignore_ascii_case("POST") {
        let host = req.hostname.to_lowercase();
        let path = req.path();

        if ANTHROPIC_HOSTS.contains(host.as_str()) && path == "/v1/messages" {
            return Some(Box::new(|req, state| {
                Box::pin(handle_anthropic_messages(req, state))
            }));
        }
        if OPENAI_HOSTS.contains(host.as_str()) && path.starts_with("/v1/chat") {
            return Some(Box::new(|req, state| {
                Box::pin(handle_openai_chat(req, state))
            }));
        }
        if GOOGLE_HOSTS.contains(host.as_str())
            && (path.contains(":generateContent") || path.contains(":streamGenerateContent"))
        {
            return Some(Box::new(|req, state| {
                Box::pin(handle_google_gemini(req, state))
            }));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::collections::HashMap;

    fn req(host: &str, path: &str, method: &str) -> HandlerRequest {
        HandlerRequest {
            method:   method.into(),
            url:      path.into(),
            headers:  HashMap::new(),
            body:     Bytes::new(),
            hostname: host.into(),
        }
    }

    #[test]
    fn anthropic_messages_routes() {
        assert!(pick_handler(&req("api.anthropic.com", "/v1/messages", "POST")).is_some());
        assert!(pick_handler(&req("api.anthropic.com", "/v1/messages?beta=1", "POST")).is_some());
    }

    #[test]
    fn openai_chat_routes() {
        assert!(pick_handler(&req("api.openai.com", "/v1/chat/completions", "POST")).is_some());
        assert!(pick_handler(&req("openrouter.ai",  "/v1/chat/completions", "POST")).is_some());
    }

    #[test]
    fn google_generate_routes() {
        assert!(pick_handler(&req(
            "generativelanguage.googleapis.com",
            "/v1beta/models/gemini-pro:generateContent",
            "POST"
        ))
        .is_some());
    }

    #[test]
    fn non_post_returns_none() {
        assert!(pick_handler(&req("api.anthropic.com", "/v1/messages", "GET")).is_none());
    }

    #[test]
    fn unknown_host_returns_none() {
        assert!(pick_handler(&req("api.example.com", "/v1/messages", "POST")).is_none());
    }

    #[test]
    fn ai_host_but_unknown_path_returns_none() {
        // Anthropic's `/v1/models` lists models but isn't anonymized.
        assert!(pick_handler(&req("api.anthropic.com", "/v1/models", "POST")).is_none());
    }

    #[test]
    fn host_match_is_case_insensitive() {
        // Some clients emit uppercase Host headers. SNIs are usually
        // lowercase but not contractually so. We `.to_lowercase()`
        // before matching to be permissive.
        assert!(pick_handler(&req("API.ANTHROPIC.COM", "/v1/messages", "POST")).is_some());
    }

    // ── SCI-150: MITM allowlist (proxy decides per-CONNECT whether to
    //    intercept or tunnel). ───────────────────────────────────────

    #[test]
    fn intercepts_known_ai_hosts() {
        assert!(is_intercepted_host("api.anthropic.com"));
        assert!(is_intercepted_host("api.openai.com"));
        assert!(is_intercepted_host("openrouter.ai"));
        assert!(is_intercepted_host("generativelanguage.googleapis.com"));
    }

    #[test]
    fn does_not_intercept_unknown_hosts() {
        // Real hosts Claude Code talks to that we should pass through:
        assert!(!is_intercepted_host("downloads.claude.ai"));
        assert!(!is_intercepted_host("http-intake.logs.us5.datadoghq.com"));
        // Generic non-AI host:
        assert!(!is_intercepted_host("github.com"));
        // api.anthropic.com path-side endpoints we don't have handlers
        // for ARE still on an intercepted host — the path-level
        // handler check handles those at the request-dispatch layer.
        // The host-level decision is intentionally coarse.
    }

    #[test]
    fn intercept_decision_is_case_insensitive() {
        assert!(is_intercepted_host("API.ANTHROPIC.COM"));
        assert!(is_intercepted_host("Api.OpenAi.Com"));
    }
}
