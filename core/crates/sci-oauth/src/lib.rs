//! Anthropic Claude Pro / Max OAuth (PKCE) client (SCI-140).
//!
//! Drop-in compatible with the TS reference at
//! `packages/ui/src/oauth.ts` (initial authorization flow) +
//! `packages/proxy/src/upstream-auth.ts` (refresh + cached-token
//! reader). Same registered `client_id`, same authorize/token URLs,
//! same scopes, same `~/.sci/oauth.json` on-disk format — a user
//! who logged in via the TS proxy can move to the Rust core without
//! re-authenticating.
//!
//! Two halves:
//!
//!   1. **Initial authorization** — `login()` runs the full PKCE
//!      flow: spin up a loopback HTTP server, generate the authorize
//!      URL, open the user's browser, capture the redirect with the
//!      auth code, exchange code → tokens, persist to
//!      `~/.sci/oauth.json` (mode 0600). User-facing CLI lives in
//!      the `sci-oauth-cli` binary inside the same crate.
//!   2. **Use + refresh** — `cached_token()` returns a fresh
//!      `access_token`, refreshing proactively if within
//!      `REFRESH_LEEWAY_MS` of expiry. Called from the
//!      `sci-handlers::anthropic` handler when no API key was
//!      injected by the credential layer (cf. SCI-128 v1).
//!
//! The macOS app integration ("Sign in with Claude" button →
//! webview → token landed in Keychain) is a follow-up that wires
//! these same functions through a Swift-callable surface. Filed as
//! SCI-146.

#![warn(clippy::all)]

mod cache;
mod flow;
mod pkce;
mod refresh;

pub use cache::{TokenInfo, cache_path, delete_cache, read_cache};
pub use flow::{AuthUrlCallback, LoginOptions, login};
pub use refresh::{cached_token, refresh_token};

use thiserror::Error;

/// The `anthropic-beta` header value the Anthropic API requires when
/// authenticating with an OAuth bearer token (vs. an x-api-key).
/// Without it, `/v1/messages` rejects the request as missing API key.
pub const ANTHROPIC_OAUTH_BETA: &str = "oauth-2025-04-20";

/// Anthropic OAuth client_id registered to Sci. Same value the TS
/// proxy uses; switching it would invalidate every existing token.
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL:     &str = "https://platform.claude.com/v1/oauth/token";

/// Refresh proactively once we're within this many millis of the
/// access_token's expiry. Anthropic tokens last ~1h; one-minute
/// leeway is plenty.
const REFRESH_LEEWAY_MS: i64 = 60_000;

/// Maximum time we wait for the user to complete browser-side
/// authorization. After this we stop the loopback server.
const BROWSER_AUTH_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// State token mismatch on the OAuth callback — likely CSRF or a
    /// stale browser tab. The flow is aborted and the user must
    /// restart.
    #[error("CSRF: state token in callback doesn't match the one we issued")]
    StateMismatch,

    #[error("OAuth callback missing `code` parameter")]
    MissingCode,

    #[error("OAuth callback returned error: {0}")]
    CallbackError(String),

    /// Browser auth wasn't completed within `BROWSER_AUTH_TIMEOUT_SECS`.
    #[error("timed out waiting for browser authorization (5 min)")]
    BrowserAuthTimeout,

    /// Anthropic's token endpoint returned non-2xx. Body is included
    /// verbatim so the caller can surface it.
    #[error("token exchange failed (HTTP {status}): {body}")]
    TokenExchange { status: u16, body: String },

    /// `cached_token()` was called but no `~/.sci/oauth.json` exists.
    /// Caller should fall back to API-key flow or prompt the user
    /// to run `sci-oauth-cli login`.
    #[error("no OAuth token cached — run `sci login` first")]
    NoCachedToken,

    /// Refresh attempted but the cached token has no `refresh_token`
    /// (rare; would happen if a partial cache got written somehow).
    #[error("cached token has no refresh_token")]
    NoRefreshToken,
}

pub type Result<T> = std::result::Result<T, OAuthError>;
