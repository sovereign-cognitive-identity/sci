//! BYO credential resolution for the helper (SCI-128, ports SCI-119).
//!
//! The TS agent shipped SCI-119 with `loadCredentials` + `injectCredentialForHost`
//! at `packages/agent/src/credentials.ts`. The macOS helper inherited
//! the rest of the engine but missed this layer — meaning until now the
//! Rust path forwarded whatever credential the calling tool sent and
//! ignored `~/.sci/credentials.env` entirely. SCI-128 v1 closes the gap.
//!
//! Resolution order, highest priority first:
//!
//!   1. Process env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
//!      `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` /
//!      `GEMINI_API_KEY`. Useful for developer launches.
//!   2. `~/.sci/credentials.env` — KEY=VALUE lines, `#` comments,
//!      optional quotes. Same format the TS agent reads, so users
//!      moving between implementations see one config.
//!   3. Pass-through whatever header the client tool sent. Keeps
//!      tool-with-its-own-key flows working when Sci has no
//!      configuration.
//!
//! Empty env strings (e.g. `ANTHROPIC_API_KEY=` exported in a shell)
//! are *not* allowed to shadow a non-empty file value. Same `nonEmpty`
//! helper bug fix from SCI-119 v1.
//!
//! **Sci sentinel tokens** (`sci_*` prefix — `sci_t_…` tier tokens,
//! `sci_p_…` per-user tokens, etc.) are recognized as "don't forward
//! upstream — fall through to Sci's own auth (OAuth, etc.)". This
//! matches the TS proxy's `isSciToken` behavior at
//! `packages/proxy/src/handlers/anthropic.ts`. Without this filter,
//! a user who has `ANTHROPIC_API_KEY=sci_t_…` exported in their shell
//! (the standard Sci-issued pattern) would have that string stamped
//! as `x-api-key` on every request and Anthropic would reject it with
//! `invalid x-api-key`.

use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub anthropic:  Option<String>,
    pub openai:     Option<String>,
    pub openrouter: Option<String>,
    pub google:     Option<String>,
}

impl Credentials {
    /// One-line summary suitable for boot-time logging. Lists which
    /// providers are configured by name only — never the key bytes.
    pub fn summary(&self) -> String {
        let providers = self.provider_names();
        if providers.is_empty() {
            "no provider keys configured".to_string()
        } else {
            format!("provider keys loaded: {}", providers.join(", "))
        }
    }

    /// Names of the providers that have a credential configured. Used
    /// by the SCI-141 reload IPC to ack which keys are now live without
    /// disclosing the key bytes themselves.
    pub fn provider_names(&self) -> Vec<&'static str> {
        let mut providers = Vec::new();
        if self.anthropic.is_some()  { providers.push("anthropic"); }
        if self.openai.is_some()     { providers.push("openai"); }
        if self.openrouter.is_some() { providers.push("openrouter"); }
        if self.google.is_some()     { providers.push("google"); }
        providers
    }
}

/// Resolve credentials from env + `~/.sci/credentials.env`. The
/// directory must already exist; we don't create it here.
pub fn load_credentials(config_dir: &Path) -> Credentials {
    let file_creds = read_credentials_file(&config_dir.join("credentials.env"));
    Credentials {
        anthropic:  real_key_from_env("ANTHROPIC_API_KEY")
            .or(file_creds.anthropic),
        openai:     real_key_from_env("OPENAI_API_KEY")
            .or(file_creds.openai),
        openrouter: real_key_from_env("OPENROUTER_API_KEY")
            .or(file_creds.openrouter),
        google:     real_key_from_env("GOOGLE_GENERATIVE_AI_API_KEY")
            .or(real_key_from_env("GEMINI_API_KEY"))
            .or(file_creds.google),
    }
}

/// True for any Sci-issued sentinel token. The TS proxy emits these
/// for users on the multi-tenant control plane (`sci_t_*` tier tokens,
/// `sci_p_*` per-user tokens). They look like API keys to a tool's
/// HTTP stack, but they're meaningless upstream — Anthropic doesn't
/// know about them and would 401. They're a sentinel for the proxy
/// to swap them for the actual OAuth bearer / configured key. We
/// filter at load time so a sentinel never gets stamped as `x-api-key`.
fn is_sci_sentinel_token(s: &str) -> bool {
    s.starts_with("sci_")
}

/// Read an env var, treat empty + Sci-sentinel values as unset. Sentinel
/// detection is logged once per load so the user can see why their
/// `ANTHROPIC_API_KEY=sci_…` shell export is being ignored.
fn real_key_from_env(key: &str) -> Option<String> {
    let raw = std::env::var(key).ok()?;
    if raw.is_empty() {
        return None;
    }
    if is_sci_sentinel_token(&raw) {
        tracing::debug!(
            env = key,
            "ignoring Sci sentinel token in env (will fall through to OAuth / file creds)",
        );
        return None;
    }
    Some(raw)
}

fn read_credentials_file(path: &Path) -> Credentials {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Credentials::default();
    };
    // Soft-warn on world-readable perms — same posture as the TS agent.
    // We log; we don't refuse. Getting in the user's way on their own
    // machine isn't worth the marginal safety win.
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            tracing::warn!(
                "{} is mode 0{:o}; recommend 0600",
                path.display(), mode
            );
        }
    }

    let mut map: HashMap<String, String> = HashMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue; };
        let key = line[..eq].trim().to_string();
        let mut value = line[eq + 1..].trim().to_string();
        // Strip matching surrounding quotes.
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len() - 1].to_string();
        }
        if !value.is_empty() {
            map.insert(key, value);
        }
    }
    // Apply the same `sci_*` sentinel filter to file-loaded values
    // — a user could have copy-pasted their Sci tier-token into
    // `~/.sci/credentials.env` thinking it was the API key.
    let take = |map: &mut HashMap<String, String>, key: &str| -> Option<String> {
        let v = map.remove(key)?;
        if is_sci_sentinel_token(&v) {
            tracing::warn!(
                key,
                "credentials.env value for {key} is a Sci sentinel token; ignoring \
                 (configure the actual provider API key, or remove the line and use OAuth)",
            );
            return None;
        }
        Some(v)
    };
    Credentials {
        anthropic:  take(&mut map, "ANTHROPIC_API_KEY"),
        openai:     take(&mut map, "OPENAI_API_KEY"),
        openrouter: take(&mut map, "OPENROUTER_API_KEY"),
        google:     take(&mut map, "GOOGLE_GENERATIVE_AI_API_KEY")
            .or_else(|| take(&mut map, "GEMINI_API_KEY")),
    }
}

/// Provider-aware credential injection. Mutates the request headers
/// in place, replacing whatever auth header the client sent with the
/// Sci-configured value for that hostname's provider.
///
/// Anthropic gets `x-api-key` (and we strip any stale `authorization`
/// the client sent so the handler's `authorization ?? x-api-key`
/// lookup lands on the freshly-injected value). OpenAI / OpenRouter
/// get `Authorization: Bearer`. Google gets `x-goog-api-key`.
///
/// If we have no configured credential for the hostname, leave the
/// headers untouched — the client's own credential (if any) flows
/// through. That preserves the "tool with its own key still works"
/// behavior.
pub fn inject_credential_for_host(
    hostname: &str,
    headers:  &mut HashMap<String, String>,
    creds:    &Credentials,
) {
    // Strip Sci sentinel tokens that may have come in on the request.
    // A tool configured with `ANTHROPIC_API_KEY=sci_t_…` (the standard
    // multi-tenant pattern) sends `x-api-key: sci_t_…` on the wire;
    // we recognize the sentinel here so it doesn't fall through to
    // upstream as a 401.
    if headers
        .get("x-api-key")
        .is_some_and(|v| is_sci_sentinel_token(v))
    {
        headers.remove("x-api-key");
    }
    if headers
        .get("authorization")
        .is_some_and(|v| {
            let v = v.trim_start_matches("Bearer ").trim();
            is_sci_sentinel_token(v)
        })
    {
        headers.remove("authorization");
    }

    let host = hostname.to_lowercase();
    match host.as_str() {
        "api.anthropic.com" => {
            if let Some(k) = &creds.anthropic {
                headers.insert("x-api-key".into(), k.clone());
                headers.remove("authorization");
            }
        }
        "api.openai.com" => {
            if let Some(k) = &creds.openai {
                headers.insert("authorization".into(), format!("Bearer {k}"));
            }
        }
        "openrouter.ai" => {
            // OpenRouter accepts the same Bearer shape as OpenAI; prefer
            // OpenRouter-specific key, fall back to OpenAI key for the
            // drop-in case.
            if let Some(k) = creds.openrouter.as_ref().or(creds.openai.as_ref()) {
                headers.insert("authorization".into(), format!("Bearer {k}"));
            }
        }
        "generativelanguage.googleapis.com" => {
            if let Some(k) = &creds.google {
                headers.insert("x-goog-api-key".into(), k.clone());
            }
        }
        _ => {
            // Unknown hostname — defense-in-depth. We only register
            // NENetworkRules for known AI hosts, but a future routing
            // change shouldn't silently leak credentials. No-op.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn empty_env_doesnt_shadow_file_value() {
        // The bug fixed in SCI-119 v1: `??` in TS treated empty string
        // as set, erasing the file value. The Rust port uses
        // `non_empty_env` to be explicit.
        // Setup: file says anthropic=foo, env says anthropic="".
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("credentials.env"),
            "ANTHROPIC_API_KEY=foo\n",
        )
        .unwrap();
        // Safety: tests run single-threaded by default with the
        // current-thread runtime; setting an env var here is fine.
        // SAFETY: see above — single-threaded test context.
        unsafe { std::env::set_var("ANTHROPIC_API_KEY", ""); }
        let creds = load_credentials(dir.path());
        unsafe { std::env::remove_var("ANTHROPIC_API_KEY"); }
        assert_eq!(creds.anthropic.as_deref(), Some("foo"));
    }

    #[test]
    fn anthropic_inject_strips_authorization() {
        let mut headers: HashMap<String, String> = HashMap::new();
        headers.insert("authorization".into(), "Bearer stale".into());
        headers.insert("anthropic-version".into(), "2023-06-01".into());

        let creds = Credentials {
            anthropic: Some("sk-ant-fresh".into()),
            ..Default::default()
        };
        inject_credential_for_host("api.anthropic.com", &mut headers, &creds);
        assert_eq!(headers.get("x-api-key").map(String::as_str), Some("sk-ant-fresh"));
        assert!(!headers.contains_key("authorization"),
            "stale Bearer should have been stripped");
    }

    #[test]
    fn openrouter_falls_back_to_openai_key() {
        let mut headers: HashMap<String, String> = HashMap::new();
        let creds = Credentials {
            openai: Some("sk-openai".into()),
            ..Default::default()
        };
        inject_credential_for_host("openrouter.ai", &mut headers, &creds);
        assert_eq!(
            headers.get("authorization").map(String::as_str),
            Some("Bearer sk-openai"),
        );
    }

    #[test]
    fn no_credential_configured_leaves_headers_untouched() {
        let mut headers: HashMap<String, String> = HashMap::new();
        headers.insert("x-api-key".into(), "sk-from-tool".into());
        let creds = Credentials::default();
        inject_credential_for_host("api.anthropic.com", &mut headers, &creds);
        // Pass-through: tool's own credential still flows.
        assert_eq!(headers.get("x-api-key").map(String::as_str), Some("sk-from-tool"));
    }

    // ── Sci sentinel-token handling ────────────────────────────────────

    #[test]
    fn sci_sentinel_in_env_is_ignored() {
        // The standard Sci tier-token pattern: user has
        // `ANTHROPIC_API_KEY=sci_t_…` exported. The Rust path used to
        // forward this verbatim; now it filters, falls through to file
        // (or OAuth, which the handler reaches when creds.anthropic is
        // None).
        let dir = tempfile::tempdir().unwrap();
        // No file → only env in play.
        unsafe { std::env::set_var(
            "ANTHROPIC_API_KEY",
            "sci_t_72bb0a81b49df1acb6c446decdfe62bd89fab44513f9c572ff4c128953fa5eb",
        ); }
        let creds = load_credentials(dir.path());
        unsafe { std::env::remove_var("ANTHROPIC_API_KEY"); }
        assert!(creds.anthropic.is_none(), "sci_* sentinel must not become a credential");
    }

    #[test]
    fn sci_sentinel_in_env_does_not_shadow_file_value() {
        // Env has a sentinel; file has a real key. Real key wins.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("credentials.env"),
            "ANTHROPIC_API_KEY=sk-ant-real\n",
        ).unwrap();
        unsafe { std::env::set_var("ANTHROPIC_API_KEY", "sci_t_xxx"); }
        let creds = load_credentials(dir.path());
        unsafe { std::env::remove_var("ANTHROPIC_API_KEY"); }
        assert_eq!(creds.anthropic.as_deref(), Some("sk-ant-real"));
    }

    #[test]
    fn sci_sentinel_in_file_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("credentials.env"),
            "ANTHROPIC_API_KEY=sci_p_alice\nOPENAI_API_KEY=sk-real-openai\n",
        ).unwrap();
        let creds = load_credentials(dir.path());
        assert!(creds.anthropic.is_none(), "sci_* in file must not become a credential");
        assert_eq!(creds.openai.as_deref(), Some("sk-real-openai"));
    }

    #[test]
    fn inject_strips_inbound_sci_sentinel_x_api_key() {
        // A tool with `ANTHROPIC_API_KEY=sci_t_…` exported sends
        // `x-api-key: sci_t_…` on the wire. The injector strips it
        // so the handler sees no auth header and can fall through
        // to OAuth.
        let mut headers: HashMap<String, String> = HashMap::new();
        headers.insert("x-api-key".into(), "sci_t_garbage".into());
        let creds = Credentials::default();
        inject_credential_for_host("api.anthropic.com", &mut headers, &creds);
        assert!(!headers.contains_key("x-api-key"), "sci_* sentinel must be stripped");
    }

    #[test]
    fn inject_strips_inbound_sci_sentinel_bearer() {
        let mut headers: HashMap<String, String> = HashMap::new();
        headers.insert("authorization".into(), "Bearer sci_t_garbage".into());
        let creds = Credentials::default();
        inject_credential_for_host("api.anthropic.com", &mut headers, &creds);
        assert!(!headers.contains_key("authorization"));
    }

    #[test]
    fn inject_preserves_real_bearer() {
        // Smoke-test the Bearer-strip logic doesn't catch real OAuth bearers.
        let mut headers: HashMap<String, String> = HashMap::new();
        headers.insert("authorization".into(), "Bearer sk-ant-real".into());
        let creds = Credentials::default();
        inject_credential_for_host("api.anthropic.com", &mut headers, &creds);
        assert_eq!(
            headers.get("authorization").map(String::as_str),
            Some("Bearer sk-ant-real"),
        );
    }
}
