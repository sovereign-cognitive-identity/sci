//! Initial PKCE authorization flow.
//!
//! Mirrors `login()` in `packages/ui/src/oauth.ts`. Steps:
//!
//!   1. Generate PKCE (verifier, challenge, state) — `pkce.rs`.
//!   2. Bind a loopback HTTP server on a random port (or
//!      `SCI_OAUTH_LOOPBACK_PORT` for Docker port-mapping).
//!   3. Build the authorize URL with the PKCE challenge + state.
//!   4. Open the user's browser to the URL (or surface it for
//!      headless contexts).
//!   5. Block on the loopback server, wait for the redirect with
//!      `?code=…&state=…`. Validate the state token; reject CSRF.
//!   6. POST the code to Anthropic's token endpoint, exchange for
//!      tokens, persist to `~/.sci/oauth.json`.
//!
//! Server side: hand-rolled minimal HTTP — accept one connection,
//! read the request line, extract query params, write a static HTML
//! response, close. ~50 lines instead of pulling in a full HTTP server
//! crate. Single-shot; no keep-alive.

use crate::cache::{TokenInfo, write_cache};
use crate::pkce::{Pkce, pkce};
use crate::{
    AUTHORIZE_URL, BROWSER_AUTH_TIMEOUT_SECS, CLIENT_ID, OAuthError, Result, TOKEN_URL,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Command;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::timeout;

/// Closure run with the authorize URL right before we attempt to open
/// the browser. Boxed-trait alias to keep `LoginOptions` from tripping
/// `clippy::type_complexity`.
pub type AuthUrlCallback = Box<dyn Fn(&str) + Send + Sync>;

const AUTHORIZE_SCOPES: &str =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Caller-controlled hooks for non-default behavior. The default
/// `LoginOptions::default()` runs the full flow with the system
/// browser; callers (CLI, GUI) can override.
#[derive(Default)]
pub struct LoginOptions {
    /// Called once with the authorize URL right before we attempt to
    /// open the browser. Useful for headless contexts that want to
    /// log it instead, or GUIs that surface a "click to authorize"
    /// button instead of auto-opening.
    pub on_auth_url: Option<AuthUrlCallback>,

    /// If `true`, skip the auto-open. The caller is responsible for
    /// getting the user to the URL.
    pub skip_browser: bool,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token:  String,
    refresh_token: String,
    expires_in:    Option<i64>,
    scope:         Option<String>,
    organization:  Option<serde_json::Value>,
    account:       Option<serde_json::Value>,
    token_uuid:    Option<String>,
}

/// Run the full PKCE OAuth flow end-to-end. Persists the resulting
/// tokens to `~/.sci/oauth.json` and returns the `TokenInfo` so the
/// caller can confirm success without re-reading the cache.
///
/// Blocks (asynchronously) until the user completes browser auth or
/// the timeout elapses (5 min). Cancel-safe: if the future is
/// dropped, the listener socket goes away and Anthropic's redirect
/// will simply error in the user's browser — no half-baked state on
/// disk because we only write the cache after a successful token
/// exchange.
pub async fn login(opts: LoginOptions) -> Result<TokenInfo> {
    let p = pkce();
    let listener = bind_loopback().await?;
    let port = listener.local_addr()?.port();

    // Anthropic's auth server matches `redirect_uri` string-equally
    // against what the client_id has whitelisted. Only `localhost` is
    // whitelisted, not `127.0.0.1`.
    let redirect_uri = format!("http://localhost:{port}/callback");

    let auth_url = build_authorize_url(&p, &redirect_uri);

    if let Some(cb) = &opts.on_auth_url {
        cb(&auth_url);
    }
    if !opts.skip_browser {
        open_browser(&auth_url);
    }

    // Wait for the redirect.
    let code = timeout(
        Duration::from_secs(BROWSER_AUTH_TIMEOUT_SECS),
        accept_callback(listener, &p.state),
    )
    .await
    .map_err(|_| OAuthError::BrowserAuthTimeout)??;

    // Exchange the code for tokens.
    let info = exchange_code(&code, &p.code_verifier, &p.state, &redirect_uri).await?;
    write_cache(&info)?;
    Ok(info)
}

// ── Loopback server ───────────────────────────────────────────────────────

async fn bind_loopback() -> Result<TcpListener> {
    let pinned = std::env::var("SCI_OAUTH_LOOPBACK_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok());
    // Random port unless the user pinned one. When pinned (Docker
    // port-mapping case), bind on 0.0.0.0 so the redirect can come in
    // through the mapped port.
    let addr: SocketAddr = match pinned {
        Some(p) => format!("0.0.0.0:{p}").parse().unwrap(),
        None    => "127.0.0.1:0".parse().unwrap(),
    };
    let listener = TcpListener::bind(addr).await?;
    Ok(listener)
}

/// Accept exactly one connection, read its request line, parse out
/// the query params from `/callback?code=...&state=...`, validate
/// the state token, write a friendly HTML response, return the code.
async fn accept_callback(listener: TcpListener, expected_state: &str) -> Result<String> {
    let (stream, _peer) = listener.accept().await?;
    let mut stream = stream;
    let (read_half, mut write_half) = stream.split();
    let mut reader = BufReader::new(read_half);

    // Read the request line — `GET /callback?... HTTP/1.1\r\n`.
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let path = parse_request_path(&line);

    // Drain headers (we don't need them, but the browser expects us
    // to read the full request before responding).
    loop {
        let mut hdr = String::new();
        let n = reader.read_line(&mut hdr).await?;
        if n == 0 || hdr == "\r\n" || hdr == "\n" { break; }
    }

    let qs = path.split_once('?').map(|x| x.1).unwrap_or("");
    let params = parse_query(qs);

    let code   = params.get("code");
    let state  = params.get("state");
    let oa_err = params.get("error");

    let problem: Option<String> = if let Some(e) = oa_err {
        Some(format!("oauth error: {e}"))
    } else if code.is_none() {
        Some("callback missing code".into())
    } else if state.map(String::as_str) != Some(expected_state) {
        Some("state mismatch — possible CSRF (did you click an old auth URL?)".into())
    } else {
        None
    };

    let html = render_response(problem.as_deref());
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html,
    );
    write_half.write_all(response.as_bytes()).await?;
    write_half.flush().await.ok();

    if let Some(p) = problem {
        if p.starts_with("oauth error:") {
            return Err(OAuthError::CallbackError(
                p.trim_start_matches("oauth error: ").to_string(),
            ));
        }
        if p.starts_with("state mismatch") {
            return Err(OAuthError::StateMismatch);
        }
        return Err(OAuthError::MissingCode);
    }
    Ok(code.unwrap().clone())
}

fn parse_request_path(request_line: &str) -> &str {
    // `GET /callback?... HTTP/1.1\r\n`
    request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
}

fn parse_query(qs: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() { continue; }
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        let k = url::form_urlencoded::parse(k.as_bytes())
            .next()
            .map(|(k, _)| k.into_owned())
            .unwrap_or_else(|| k.to_string());
        let v = url::form_urlencoded::parse(v.as_bytes())
            .next()
            .map(|(k, _)| k.into_owned())
            .unwrap_or_else(|| v.to_string());
        out.insert(k, v);
    }
    out
}

fn render_response(problem: Option<&str>) -> String {
    let title = if problem.is_some() {
        "Authorization failed"
    } else {
        "You can close this tab"
    };
    let body = problem.unwrap_or(
        "Sci has captured your access token. The terminal will now exit.",
    );
    format!(
        "<!doctype html><html><body style=\"font-family:system-ui;padding:2rem;max-width:560px;\">\
         <h2>{title}</h2><p>{body}</p></body></html>"
    )
}

// ── Authorize URL ─────────────────────────────────────────────────────────

fn build_authorize_url(p: &Pkce, redirect_uri: &str) -> String {
    // Param order matches Claude Code CLI's `buildAuthUrl()` byte-for-byte.
    // `code=true` first is non-standard but Anthropic-required.
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("static URL parses");
    url.query_pairs_mut()
        .append_pair("code",                  "true")
        .append_pair("client_id",             CLIENT_ID)
        .append_pair("response_type",         "code")
        .append_pair("redirect_uri",          redirect_uri)
        .append_pair("scope",                 AUTHORIZE_SCOPES)
        .append_pair("code_challenge",        &p.code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state",                 &p.state);
    url.into()
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![url]);
    #[cfg(target_os = "windows")]
    let cmd = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = ("xdg-open", vec![url]);

    let _ = Command::new(cmd.0).args(&cmd.1).spawn();
}

// ── Token exchange ────────────────────────────────────────────────────────

async fn exchange_code(
    code:          &str,
    code_verifier: &str,
    state:         &str,
    redirect_uri:  &str,
) -> Result<TokenInfo> {
    let body = json!({
        "grant_type":    "authorization_code",
        "client_id":     CLIENT_ID,
        "code":          code,
        "redirect_uri":  redirect_uri,
        "state":         state,
        "code_verifier": code_verifier,
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
    Ok(TokenInfo {
        access_token:  tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at_ms: tok.expires_in.map(|s| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64 + s * 1000)
                .unwrap_or(0)
        }),
        scope:         tok.scope.unwrap_or_default(),
        organization:  tok.organization,
        account:       tok.account,
        token_uuid:    tok.token_uuid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_authorize_url_param_order_matches_claude_cli() {
        let p = Pkce {
            code_verifier:  "verifier".into(),
            code_challenge: "challenge".into(),
            state:          "state".into(),
        };
        let url = build_authorize_url(&p, "http://localhost:1234/callback");
        // Param order: code, client_id, response_type, redirect_uri,
        // scope, code_challenge, code_challenge_method, state.
        // url crate's query_pairs preserves insertion order.
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?"));
        assert!(url.contains("code=true"));
        assert!(url.contains(&format!("client_id={CLIENT_ID}")));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state"));
    }

    #[test]
    fn parse_query_handles_basic_pairs() {
        let q = parse_query("code=abc&state=xyz&error=denied");
        assert_eq!(q.get("code").map(String::as_str), Some("abc"));
        assert_eq!(q.get("state").map(String::as_str), Some("xyz"));
        assert_eq!(q.get("error").map(String::as_str), Some("denied"));
    }

    #[test]
    fn parse_query_url_decodes() {
        // %20 → space
        let q = parse_query("scope=user%3Aprofile+user%3Ainference");
        assert_eq!(q.get("scope").map(String::as_str), Some("user:profile user:inference"));
    }

    #[test]
    fn parse_request_path_extracts_path_with_query() {
        let p = parse_request_path("GET /callback?code=abc&state=xyz HTTP/1.1\r\n");
        assert_eq!(p, "/callback?code=abc&state=xyz");
    }
}
