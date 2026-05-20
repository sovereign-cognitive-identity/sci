//! `sci-oauth-cli` — one-shot CLI for the Claude Pro / Max OAuth flow.
//!
//! Subcommands:
//!
//!   - `login`     run the full PKCE flow, write `~/.sci/oauth.json`
//!   - `status`    print the cached token's metadata + expiry
//!   - `logout`    delete `~/.sci/oauth.json`
//!   - `print`     print the current bearer (refreshing if needed) —
//!     useful for shell wrappers that want to drive
//!     `curl -H "Authorization: Bearer $(sci-oauth-cli print)"`
//!
//! The binary is intentionally tiny — all real logic lives in the
//! library so the macOS app can call the same functions through a
//! Swift bridge. See SCI-146 for that follow-up.

use sci_oauth::{LoginOptions, OAuthError, cache_path, cached_token, delete_cache, login, read_cache};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "login".into());

    let exit = match cmd.as_str() {
        "login"     => run_login().await,
        "status"    => run_status(),
        "logout"    => run_logout(),
        "print"     => run_print().await,
        "-h" | "--help" | "help" => { print_help(); 0 }
        other => {
            eprintln!("unknown subcommand: {other}\n");
            print_help();
            2
        }
    };
    std::process::exit(exit);
}

fn print_help() {
    eprintln!("Usage: sci-oauth-cli <login|status|logout|print|help>");
    eprintln!();
    eprintln!("  login    run the Claude Pro/Max OAuth flow and persist tokens");
    eprintln!("  status   print metadata about the currently-cached token");
    eprintln!("  logout   delete the cached token (~/.sci/oauth.json)");
    eprintln!("  print    print a fresh access_token, refreshing if needed");
}

async fn run_login() -> i32 {
    println!("opening your browser to authorize Sci with Claude…");
    println!("(if it doesn't open automatically, the URL will print below)");
    let opts = LoginOptions {
        on_auth_url: Some(Box::new(|url| {
            println!();
            println!("→ {url}");
            println!();
        })),
        skip_browser: false,
    };
    match login(opts).await {
        Ok(info) => {
            println!("✔ logged in. Token cached at {}", cache_path().display());
            if !info.scope.is_empty() {
                println!("  scope: {}", info.scope);
            }
            0
        }
        Err(e) => {
            eprintln!("login failed: {e}");
            1
        }
    }
}

fn run_status() -> i32 {
    match read_cache() {
        Ok(Some(info)) => {
            println!("path:          {}", cache_path().display());
            // Print a head/tail of the bearer so the user can confirm
            // it's the one they expect without leaking the full token
            // into shell history if they pipe `status` into a paste.
            let head: String = info.access_token.chars().take(8).collect();
            let tail_chars: Vec<char> = info.access_token.chars().collect();
            let tail: String = tail_chars
                .iter()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            println!(
                "access_token:  {head}…{tail} ({} chars)",
                info.access_token.len(),
            );
            println!("scope:         {}", info.scope);
            if let Some(exp) = info.expires_at_ms {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let secs = (exp - now) / 1000;
                println!("expires_in:    {secs}s");
            } else {
                println!("expires_in:    (no expiry recorded)");
            }
            if let Some(uuid) = info.token_uuid {
                println!("token_uuid:    {uuid}");
            }
            0
        }
        Ok(None) => {
            eprintln!("no cached token. Run `sci-oauth-cli login`.");
            1
        }
        Err(e) => {
            eprintln!("read cache failed: {e}");
            1
        }
    }
}

fn run_logout() -> i32 {
    let path = cache_path();
    let existed = path.exists();
    match delete_cache() {
        Ok(()) => {
            if existed {
                println!("✔ deleted {}", path.display());
            } else {
                println!("(no cached token to delete)");
            }
            0
        }
        Err(e) => {
            eprintln!("logout failed: {e}");
            1
        }
    }
}

async fn run_print() -> i32 {
    match cached_token().await {
        Ok(t) => {
            println!("{t}");
            0
        }
        Err(OAuthError::NoCachedToken) => {
            eprintln!("no cached token. Run `sci-oauth-cli login`.");
            1
        }
        Err(e) => {
            eprintln!("token read failed: {e}");
            1
        }
    }
}
