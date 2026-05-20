//! `sci-helper --setup` — first-run wizard.
//!
//! Interactive mode (default) steps:
//!   1. Create `~/.sci/` (mode 0700) and `~/.sci/memory/` if absent.
//!   2. Prompt for API keys and write `~/.sci/credentials.env` (mode 0600).
//!   3. Advise on CA generation.
//!   4. Print shell export lines and optionally append to `~/.zshrc`.
//!   5. Generate and write the launchd plist.
//!   6. Print a setup summary.
//!
//! Non-interactive mode (`--non-interactive`, for brew `post_install`):
//!   - Steps 1, 3, 4 run unconditionally (zshrc append is automatic).
//!   - Step 2 is skipped — no credentials.env is written; the user runs
//!     `sci-helper --setup` later to enter keys.
//!   - Step 5 is skipped — brew owns service management via
//!     `brew services`, and writing our own plist would create a
//!     conflicting launchd entry on the same port.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

/// Entry point called from `main.rs` when `--setup` is passed.
pub fn run(non_interactive: bool) -> anyhow::Result<()> {
    let home = home_dir()?;
    let config_dir = home.join(".sci");
    let memory_dir = config_dir.join("memory");

    // ── Step 1: Create ~/.sci/ and ~/.sci/memory/ ─────────────────────
    create_dir_0700(&config_dir)?;
    println!("✓ {} exists", config_dir.display());

    std::fs::create_dir_all(&memory_dir)?;
    println!("✓ {} exists", memory_dir.display());

    // ── Step 2: Credentials ───────────────────────────────────────────
    let creds_path = config_dir.join("credentials.env");
    if non_interactive {
        println!("  Skipping credentials prompt (non-interactive). Run `sci-helper --setup` to add API keys.");
    } else if creds_path.exists() {
        println!("✓ {} already exists — skipping key prompts", creds_path.display());
    } else {
        write_credentials(&creds_path)?;
    }

    // ── Step 3: CA advice ─────────────────────────────────────────────
    let ca_path = config_dir.join("ca.crt");
    if !ca_path.exists() {
        println!();
        println!("  CA will be generated on first `sci-helper --proxy` start.");
        println!("  After that, run `sci-helper --trust-ca` to add it to your keychain.");
    } else {
        println!("✓ CA certificate found at {}", ca_path.display());
    }

    // ── Step 4: Shell exports ──────────────────────────────────────────
    let export_lines = shell_export_lines();
    println!();
    println!("Add these lines to your shell config:");
    println!();
    for line in &export_lines {
        println!("  {line}");
    }

    println!();
    let should_append = if non_interactive {
        true
    } else {
        print!("Add to ~/.zshrc now? [Y/n]: ");
        io::stdout().flush()?;
        let answer = read_line()?;
        let answer = answer.trim().to_lowercase();
        answer.is_empty() || answer == "y" || answer == "yes"
    };
    if should_append {
        upsert_setup_block(&home, &export_lines)?;
        println!("✓ Sci-managed block written to ~/.zshrc");
    } else {
        println!("  Skipped — add them manually when ready.");
    }

    // ── Step 5: Launchd plist ──────────────────────────────────────────
    //
    // Skipped in non-interactive mode: when sci-helper is installed via
    // brew, `brew services` already manages the launchd entry (label
    // `homebrew.mxcl.sci`). Writing our own `com.sci.helper.plist` here
    // would produce two agents fighting for port 3001 — the second one
    // to start fails with EADDRINUSE.
    let plist_path: Option<PathBuf> = if non_interactive {
        println!();
        println!("  Skipping launchd plist (non-interactive). Use `brew services start sci`.");
        None
    } else {
        let binary_path = current_binary_path();
        let plist_xml = generate_launchd_plist(&binary_path, &config_dir, &home);
        let launch_agents = home.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&launch_agents)?;
        let path = launch_agents.join("com.sci.helper.plist");
        std::fs::write(&path, plist_xml)?;

        println!();
        println!("Launchd plist written to {}", path.display());
        println!();
        println!("To start Sci on login:");
        println!("  launchctl load ~/Library/LaunchAgents/com.sci.helper.plist");
        println!("To start now:");
        println!("  launchctl start com.sci.helper");
        Some(path)
    };

    // ── Step 6: Summary ────────────────────────────────────────────────
    println!();
    println!("─── Setup summary ───────────────────────────────────────────────");
    println!("  Config dir     : {}", config_dir.display());
    println!("  Memory dir     : {}", memory_dir.display());
    if !non_interactive {
        println!("  Credentials    : {}", creds_path.display());
    }
    if let Some(p) = &plist_path {
        println!("  Launchd plist  : {}", p.display());
    }
    println!();
    println!("Next steps:");
    if non_interactive {
        println!("  1. Run `sci-helper --setup` to enter API keys when ready.");
        println!("  2. Run `sci-helper --trust-ca` (needs sudo) to install the CA.");
        println!("  3. Open a new terminal (or `source ~/.zshrc`) to pick up HTTPS_PROXY.");
    } else if !ca_path.exists() {
        println!("  1. Run `sci-helper --proxy 3001` once to generate the CA certificate.");
        println!("  2. Run `sci-helper --trust-ca` to add it to your keychain.");
        println!("  3. Load the launchd agent (see command above) so sci-helper starts on login.");
        println!("  4. Run `sci-helper --verify` to confirm everything is working.");
    } else {
        println!("  1. Load the launchd agent (see command above) so sci-helper starts on login.");
        println!("  2. Run `sci-helper --trust-ca` if you haven't already.");
        println!("  3. Run `sci-helper --verify` to confirm everything is working.");
    }

    Ok(())
}

/// Generate the launchd plist XML string.
pub fn generate_launchd_plist(binary_path: &Path, config_dir: &Path, home: &Path) -> String {
    let binary_str   = binary_path.display();
    let config_str   = config_dir.display();
    let home_str     = home.display();
    let log_path     = config_dir.join("helper.log");
    let log_str      = log_path.display();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sci.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>{binary_str}</string>
    <string>--proxy</string>
    <string>3001</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCI_CONFIG_DIR</key><string>{config_str}</string>
    <key>HOME</key><string>{home_str}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>{log_str}</string>
  <key>StandardOutPath</key><string>{log_str}</string>
</dict>
</plist>
"#
    )
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn home_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| anyhow::anyhow!("$HOME is not set"))?;
    Ok(PathBuf::from(home))
}

/// Create `dir` with mode 0700 (owner-only rwx) on Unix, or just
/// `create_dir_all` on non-Unix platforms.
fn create_dir_0700(dir: &Path) -> anyhow::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// Prompt for API keys and write `credentials.env` with mode 0600.
fn write_credentials(path: &Path) -> anyhow::Result<()> {
    println!();
    println!("Configure API keys (press Enter to skip an optional key):");
    println!();

    print!("Anthropic API key (sk-ant-...): ");
    io::stdout().flush()?;
    let anthropic = read_line()?;
    let anthropic = anthropic.trim().to_string();

    print!("OpenAI API key (sk-... or leave blank): ");
    io::stdout().flush()?;
    let openai = read_line()?;
    let openai = openai.trim().to_string();

    let mut contents = String::new();
    if !anthropic.is_empty() {
        contents.push_str(&format!("ANTHROPIC_API_KEY={anthropic}\n"));
    }
    if !openai.is_empty() {
        contents.push_str(&format!("OPENAI_API_KEY={openai}\n"));
    }

    std::fs::write(path, &contents)?;

    // Set mode 0600 on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }

    println!("✓ Credentials written to {}", path.display());
    Ok(())
}

fn shell_export_lines() -> Vec<String> {
    vec![
        "export HTTPS_PROXY=http://localhost:3001".to_string(),
        "export NODE_EXTRA_CA_CERTS=$HOME/.sci/ca.crt".to_string(),
        // Exclude brew, git hosting, and local services from the proxy.
        // Without this, `brew update` and `brew tap` route through
        // sci-helper before it is running and fail with a
        // connection-refused error. `github.com` and `api.github.com`
        // are required because the tap is fetched from GitHub.
        "export NO_PROXY=localhost,127.0.0.1,github.com,api.github.com,*.brew.sh,formulae.brew.sh,raw.githubusercontent.com,objects.githubusercontent.com".to_string(),
    ]
}

/// Paired markers delimit the sci-managed block in `~/.zshrc`. Anything
/// between them is owned by `--setup` and gets replaced on re-run.
const BEGIN_MARKER:  &str = "# >>> sci-helper --setup >>>";
const END_MARKER:    &str = "# <<< sci-helper --setup <<<";

/// Pre-0.5.1 marker. Single line, no paired terminator. When we see
/// it, the lines immediately after it that match our known exports
/// (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, NO_PROXY) are removed too.
const LEGACY_MARKER: &str = "# Added by sci-helper --setup";

/// Write the sci-managed export block to `~/.zshrc`. Idempotent:
///
/// - If a `# >>> sci-helper --setup >>>` / `# <<< sci-helper --setup <<<`
///   block already exists, it is replaced in place (preserving any
///   user content outside the markers).
/// - If a legacy `# Added by sci-helper --setup` block exists (one
///   marker line followed by our HTTPS_PROXY/NODE_EXTRA_CA_CERTS/NO_PROXY
///   exports), it is removed before the new paired block is appended.
/// - If neither exists, the new block is appended at the end.
///
/// Anything the user added inside the markers gets overwritten; the
/// migration section of docs/INSTALL.md tells them to move local edits
/// outside the markers before re-running setup.
fn upsert_setup_block(home: &Path, lines: &[String]) -> anyhow::Result<()> {
    let zshrc = home.join(".zshrc");

    let existing = match std::fs::read_to_string(&zshrc) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };

    let cleaned = strip_existing_setup_blocks(&existing);

    let mut out = cleaned.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(BEGIN_MARKER);
    out.push('\n');
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(END_MARKER);
    out.push('\n');

    std::fs::write(&zshrc, out)?;
    Ok(())
}

/// Remove any existing sci-managed block(s) from `content`. Handles
/// both the paired-marker (0.5.1+) and legacy single-marker (0.5.0)
/// formats. Anything outside the blocks is preserved verbatim,
/// including trailing newline semantics.
fn strip_existing_setup_blocks(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let had_trailing_newline = content.ends_with('\n');
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        if line.trim_end() == BEGIN_MARKER {
            // Paired block: drop everything through END_MARKER.
            i += 1;
            while i < lines.len() && lines[i].trim_end() != END_MARKER {
                i += 1;
            }
            if i < lines.len() {
                i += 1; // consume END_MARKER itself
            }
            continue;
        }

        if line.trim_end() == LEGACY_MARKER {
            // Legacy block: drop the marker and any immediately
            // following lines that match our known exports. Stops at
            // the first line that isn't one of ours, so unrelated
            // user content following the block is preserved.
            i += 1;
            while i < lines.len() {
                let l = lines[i].trim_start();
                if l.starts_with("export HTTPS_PROXY=")
                    || l.starts_with("export NODE_EXTRA_CA_CERTS=")
                    || l.starts_with("export NO_PROXY=")
                {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }

        out.push(line);
        i += 1;
    }

    let mut result = out.join("\n");
    if had_trailing_newline && !result.is_empty() {
        result.push('\n');
    }
    result
}

/// Returns the path to the currently-running binary, falling back to
/// `sci-helper` if `std::env::current_exe()` fails.
fn current_binary_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("sci-helper"))
}

fn read_line() -> anyhow::Result<String> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_empty_input_returns_empty() {
        assert_eq!(strip_existing_setup_blocks(""), "");
    }

    #[test]
    fn strip_no_markers_preserves_content_and_trailing_newline() {
        let input = "export FOO=bar\nexport BAZ=qux\n";
        assert_eq!(strip_existing_setup_blocks(input), input);
    }

    #[test]
    fn strip_no_markers_preserves_lack_of_trailing_newline() {
        let input = "export FOO=bar\nexport BAZ=qux";
        assert_eq!(strip_existing_setup_blocks(input), input);
    }

    #[test]
    fn strip_paired_block_removes_only_the_block() {
        let input = "\
export USER_VAR=keep
# >>> sci-helper --setup >>>
export HTTPS_PROXY=http://localhost:3001
export NO_PROXY=localhost
# <<< sci-helper --setup <<<
export ANOTHER_USER_VAR=keep
";
        let expected = "\
export USER_VAR=keep
export ANOTHER_USER_VAR=keep
";
        assert_eq!(strip_existing_setup_blocks(input), expected);
    }

    #[test]
    fn strip_legacy_block_removes_marker_and_known_exports() {
        let input = "\
export USER_VAR=keep

# Added by sci-helper --setup
export HTTPS_PROXY=http://localhost:3001
export NODE_EXTRA_CA_CERTS=$HOME/.sci/ca.crt
export NO_PROXY=localhost,127.0.0.1,*.brew.sh
export USER_VAR_AFTER=keep
";
        let expected = "\
export USER_VAR=keep

export USER_VAR_AFTER=keep
";
        assert_eq!(strip_existing_setup_blocks(input), expected);
    }

    #[test]
    fn strip_legacy_block_stops_at_unrelated_export() {
        // User added their own export immediately after the legacy
        // marker — only the marker and our known exports are removed;
        // the user's export is preserved.
        let input = "\
# Added by sci-helper --setup
export HTTPS_PROXY=http://localhost:3001
export USER_EXPORT=keep
export NO_PROXY=localhost
";
        let expected = "\
export USER_EXPORT=keep
export NO_PROXY=localhost
";
        assert_eq!(strip_existing_setup_blocks(input), expected);
    }

    #[test]
    fn strip_handles_both_legacy_and_paired_blocks() {
        let input = "\
# Added by sci-helper --setup
export HTTPS_PROXY=http://localhost:3001

# >>> sci-helper --setup >>>
export HTTPS_PROXY=http://localhost:3001
# <<< sci-helper --setup <<<
export USER=keep
";
        let expected = "\

export USER=keep
";
        assert_eq!(strip_existing_setup_blocks(input), expected);
    }

    #[test]
    fn strip_paired_block_with_missing_end_marker_consumes_to_eof() {
        // Defensive: a truncated file with begin but no end marker.
        // Better to consume to EOF than leave a dangling begin marker.
        let input = "\
export USER=keep
# >>> sci-helper --setup >>>
export HTTPS_PROXY=http://localhost:3001
";
        let expected = "\
export USER=keep
";
        assert_eq!(strip_existing_setup_blocks(input), expected);
    }

    #[test]
    fn upsert_round_trip_is_stable() {
        // Writing the same exports twice produces the same file
        // contents — the core idempotency guarantee.
        let tmp = std::env::temp_dir().join(format!(
            "sci-setup-upsert-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let zshrc = tmp.join(".zshrc");
        std::fs::write(&zshrc, "export USER_VAR=keep\n").unwrap();

        let exports = vec![
            "export HTTPS_PROXY=http://localhost:3001".to_string(),
            "export NO_PROXY=localhost,127.0.0.1,github.com".to_string(),
        ];

        upsert_setup_block(&tmp, &exports).unwrap();
        let first = std::fs::read_to_string(&zshrc).unwrap();
        upsert_setup_block(&tmp, &exports).unwrap();
        let second = std::fs::read_to_string(&zshrc).unwrap();

        assert_eq!(first, second, "upsert should be idempotent");
        assert!(first.contains("export USER_VAR=keep"), "user content preserved");
        assert_eq!(
            first.matches(BEGIN_MARKER).count(),
            1,
            "exactly one begin marker after re-upsert"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
