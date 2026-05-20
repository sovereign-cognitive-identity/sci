//! `sci-tail` — pretty-print the helper's event stream in real time.
//!
//! Connects to the helper control socket, sends the SCI-138
//! `{"kind":"events"}` subscription header, then reads JSON-line
//! events forever and renders one human-readable line per event:
//!
//! ```text
//! 12:34:56  → api.anthropic.com
//! 12:34:57  ✓ api.anthropic.com           200  masked=2   834ms
//! 12:34:59  ✗ api.openai.com              http parse: client closed before headers complete
//! 12:35:01  ⟳ credentials reloaded       providers=anthropic,openai
//! ```
//!
//! Run in a second terminal alongside `sci-helper`. No CLI flags;
//! defaults match the helper's defaults (`~/.sci/helper.sock` or
//! `SCI_HELPER_SOCKET`).
//!
//! The binary is intentionally minimal — it's a debug/dogfood console,
//! not a production UI. The macOS app's Settings → Status pane is the
//! polished surface; this is for terminal-driven dogfood while we
//! wait on the NE entitlement.

use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

// ── ANSI escape helpers (stdlib-only, no `colored` crate dependency) ──
const RESET:  &str = "\x1b[0m";
const DIM:    &str = "\x1b[2m";
const BOLD:   &str = "\x1b[1m";
const RED:    &str = "\x1b[31m";
const GREEN:  &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const BLUE:   &str = "\x1b[34m";
const CYAN:   &str = "\x1b[36m";

fn default_socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SCI_HELPER_SOCKET") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".sci").join("helper.sock")
}

/// CLI: `sci-tail [--bodies]`. `--bodies` enables rendering of the
/// `flow_anonymized_request` / `flow_upstream_raw_response` events
/// indented under their flow. Off by default to keep the default view
/// compact.
struct Cli {
    bodies: bool,
}

fn parse_args() -> Cli {
    let mut bodies = false;
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--bodies" | "-b" => bodies = true,
            "-h" | "--help" => {
                eprintln!("Usage: sci-tail [--bodies]");
                eprintln!("  --bodies   render anonymized request + raw upstream response inline");
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown arg: {other}");
                std::process::exit(2);
            }
        }
    }
    Cli { bodies }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let cli = parse_args();
    let path = default_socket_path();
    let stream = UnixStream::connect(&path)
        .await
        .with_context(|| format!("connect to helper socket at {}", path.display()))?;
    eprintln!(
        "{DIM}sci-tail{RESET} connected to {}{}",
        path.display(),
        if cli.bodies { format!("  {DIM}(--bodies){RESET}") } else { String::new() },
    );

    let (read_half, mut write_half) = stream.into_split();
    write_half.write_all(b"{\"kind\":\"events\"}\n").await?;
    write_half.flush().await?;

    let mut reader = BufReader::new(read_half);
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Err(anyhow!("helper closed the event stream"));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() { continue; }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => print_event(&v, &cli),
            Err(e) => {
                eprintln!("{DIM}(unparseable line: {e}: {trimmed:?}){RESET}");
            }
        }
    }
}

/// Render one event as a colored, fixed-column line.
///
/// Format: `HH:MM:SS  ICON HOSTNAME(40)  STATUS(4) masked=N(8) MS ms[ extra]`
fn print_event(v: &Value, cli: &Cli) {
    let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("?");
    let ts_ms = v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0);
    let ts = format_ts(ts_ms);

    match kind {
        "subscribed" => {
            println!("{ts}  {DIM}subscribed to event bus{RESET}");
        }
        "embedder_loading" => {
            println!("{ts}  {YELLOW}⏳ embedder loading…{RESET}");
        }
        "embedder_ready" => {
            println!("{ts}  {GREEN}✓ embedder ready{RESET}");
        }
        "flow_started" => {
            let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("?");
            println!(
                "{ts}  {CYAN}→{RESET} {BOLD}{host:<40}{RESET}",
            );
        }
        "flow_completed" => {
            let host   = v.get("host").and_then(|x| x.as_str()).unwrap_or("?");
            let status = v.get("status").and_then(|x| x.as_u64()).unwrap_or(0);
            let masked = v.get("masked").and_then(|x| x.as_u64()).unwrap_or(0);
            let ms     = v.get("ms").and_then(|x| x.as_u64()).unwrap_or(0);
            let status_color = if (200..300).contains(&status) {
                GREEN
            } else if (400..500).contains(&status) {
                YELLOW
            } else {
                RED
            };
            let icon_color = if (200..300).contains(&status) { GREEN } else { RED };
            let icon = if (200..300).contains(&status) { "✓" } else { "✗" };
            println!(
                "{ts}  {icon_color}{icon}{RESET} {host:<40} \
                 {status_color}{status}{RESET}  \
                 {DIM}masked={RESET}{masked:<3}  {DIM}{ms}ms{RESET}",
            );
        }
        "flow_error" => {
            let host  = v.get("host").and_then(|x| x.as_str()).unwrap_or("?");
            let error = v.get("error").and_then(|x| x.as_str()).unwrap_or("?");
            println!(
                "{ts}  {RED}✗{RESET} {host:<40} {RED}{error}{RESET}",
            );
        }
        "flow_anonymized_request" => {
            if !cli.bodies { return; }
            let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("?");
            let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
            println!(
                "{ts}  {DIM}↳ request → upstream  {host}  ({} bytes){RESET}",
                body.len(),
            );
            print_indented_body(body);
        }
        "flow_upstream_raw_response" => {
            if !cli.bodies { return; }
            let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("?");
            let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
            println!(
                "{ts}  {DIM}↳ upstream → deanon   {host}  ({} bytes){RESET}",
                body.len(),
            );
            print_indented_body(body);
        }
        "credentials_reloaded" => {
            let providers = v
                .get("providers")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_else(|| "(none)".into());
            println!(
                "{ts}  {BLUE}⟳{RESET} credentials reloaded                 \
                 {DIM}providers={RESET}{providers}",
            );
        }
        other => {
            // Forward-compat: unknown event types render verbatim so a
            // helper running ahead of sci-tail still shows useful info.
            println!("{ts}  {DIM}{other}{RESET}  {trimmed}", trimmed = v);
        }
    }
}

/// Pretty-print a JSON body indented under its event line. We try to
/// parse + re-emit pretty so multi-line JSON renders readably; if it
/// doesn't parse (e.g. SSE chunks landing here in a future version),
/// we just dump the raw string with a left margin.
fn print_indented_body(body: &str) {
    let pretty = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| body.to_string());
    for line in pretty.lines() {
        println!("    {DIM}│{RESET} {line}");
    }
}

/// Render an epoch-millis timestamp as local-time `HH:MM:SS`. Falls
/// back to a dim placeholder if `ts_ms == 0` (subscriber-ack frame
/// has no ts field).
fn format_ts(ts_ms: i64) -> String {
    if ts_ms == 0 {
        return format!("{DIM}--:--:--{RESET}");
    }
    chrono::DateTime::<chrono::Local>::from(
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(ts_ms as u64),
    )
    .format("%H:%M:%S")
    .to_string()
}
