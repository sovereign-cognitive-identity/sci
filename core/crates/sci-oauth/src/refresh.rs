//! Token refresh + cached_token API.
//!
//! The Anthropic handler reads `cached_token()` whenever no API key
//! was injected by the credential layer. The function returns a fresh
//! `access_token`, refreshing proactively if the cache is within
//! `REFRESH_LEEWAY_MS` of expiry. Refreshes are deduped with a
//! `tokio::sync::Mutex` so concurrent flows can't trigger N parallel
//! refreshes (Anthropic rate-limits and we'd race on the cache file).

use crate::cache::{TokenInfo, read_cache, write_cache};
use crate::{CLIENT_ID, OAuthError, REFRESH_LEEWAY_MS, Result, TOKEN_URL};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Refresh-eligible scopes. `org:create_api_key` is one-shot at
/// authorize time and gets dropped after the initial auth — sending
/// it on refresh returns 400 invalid_scope. Used as a fallback when
/// the cached `scope` is empty (e.g. read of an older cache that
/// didn't persist the field).
const REFRESH_SCOPES_FALLBACK: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Per-process refresh dedup. Multiple async callers of `cached_token`
/// during a refresh window all queue behind the same lock, so only
/// one `refresh_token` call hits Anthropic.
static REFRESH_GUARD: Lazy<Arc<Mutex<()>>> = Lazy::new(|| Arc::new(Mutex::new(())));

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token:  String,
    refresh_token: Option<String>,
    expires_in:    Option<i64>,
    scope:         Option<String>,
    organization:  Option<serde_json::Value>,
    account:       Option<serde_json::Value>,
    token_uuid:    Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn token_info_from_response(tok: TokenResponse, prev: Option<&TokenInfo>) -> TokenInfo {
    TokenInfo {
        access_token:  tok.access_token,
        refresh_token: tok
            .refresh_token
            .or_else(|| prev.map(|p| p.refresh_token.clone()))
            .unwrap_or_default(),
        expires_at_ms: tok.expires_in.map(|s| now_ms() + s * 1000),
        scope:         tok
            .scope
            .or_else(|| prev.map(|p| p.scope.clone()))
            .unwrap_or_default(),
        organization:  tok.organization.or_else(|| prev.and_then(|p| p.organization.clone())),
        account:       tok.account.or_else(|| prev.and_then(|p| p.account.clone())),
        token_uuid:    tok.token_uuid.or_else(|| prev.and_then(|p| p.token_uuid.clone())),
    }
}

/// Rotate `access_token` using the cached `refresh_token`. Mutates
/// the on-disk cache. Returns the freshly-issued `TokenInfo`.
pub async fn refresh_token() -> Result<TokenInfo> {
    let cache = read_cache()?
        .ok_or(OAuthError::NoCachedToken)?;
    if cache.refresh_token.is_empty() {
        return Err(OAuthError::NoRefreshToken);
    }

    let scope = if cache.scope.is_empty() {
        REFRESH_SCOPES_FALLBACK.to_string()
    } else {
        cache.scope.clone()
    };

    let body = json!({
        "grant_type":    "refresh_token",
        "client_id":     CLIENT_ID,
        "refresh_token": cache.refresh_token,
        "scope":         scope,
    });

    let res = reqwest::Client::new()
        .post(TOKEN_URL)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body)?)
        .send()
        .await?;

    let status = res.status().as_u16();
    let text   = res.text().await?;
    if !(200..300).contains(&status) {
        return Err(OAuthError::TokenExchange { status, body: text });
    }

    let tok: TokenResponse = serde_json::from_str(&text)?;
    let info = token_info_from_response(tok, Some(&cache));
    write_cache(&info)?;
    Ok(info)
}

/// Read the cached `access_token`, refreshing if within
/// `REFRESH_LEEWAY_MS` of expiry. Returns the bearer string suitable
/// for `Authorization: Bearer <token>`.
///
/// The handler in `sci-handlers::anthropic` calls this when the
/// request didn't carry an `x-api-key` and we want to fall back to
/// the OAuth bearer.
pub async fn cached_token() -> Result<String> {
    let cache = read_cache()?
        .ok_or(OAuthError::NoCachedToken)?;

    let needs_refresh = cache
        .expires_at_ms
        .is_some_and(|exp| exp - now_ms() < REFRESH_LEEWAY_MS);

    if !needs_refresh {
        return Ok(cache.access_token);
    }

    // Concurrency guard: only one refresh in flight at a time.
    let _guard = REFRESH_GUARD.lock().await;
    // Re-read cache after acquiring the lock — the previous holder
    // may have already refreshed.
    let cache = read_cache()?
        .ok_or(OAuthError::NoCachedToken)?;
    let still_needs = cache
        .expires_at_ms
        .is_some_and(|exp| exp - now_ms() < REFRESH_LEEWAY_MS);
    if !still_needs {
        return Ok(cache.access_token);
    }

    let next = refresh_token().await?;
    Ok(next.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::write_cache;

    fn isolated_cache_path() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oauth.json");
        // SAFETY: see cache.rs tests — single-threaded test context.
        unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }
        dir
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn cached_token_returns_unexpired() {
        let _dir = isolated_cache_path();
        write_cache(&TokenInfo {
            access_token:  "still-good".into(),
            refresh_token: "rrr".into(),
            // 10 minutes from now
            expires_at_ms: Some(now_ms() + 10 * 60 * 1000),
            scope:         "user:inference".into(),
            organization:  None,
            account:       None,
            token_uuid:    None,
        }).unwrap();
        let t = cached_token().await.unwrap();
        assert_eq!(t, "still-good");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn cached_token_no_cache_errors() {
        let _dir = isolated_cache_path();
        let r = cached_token().await;
        assert!(matches!(r, Err(OAuthError::NoCachedToken)));
    }
}
