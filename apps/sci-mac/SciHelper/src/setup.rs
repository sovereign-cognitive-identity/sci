//! `sci-helper --setup` — interactive first-run wizard.
//!
//! Steps:
//!   1. Create `~/.sci/` (mode 0700) and `~/.sci/memory/` if absent.
//!   2. Prompt for API keys and write `~/.sci/credentials.env` (mode 0600).
//!   3. Advise on CA generation.
//!   4. Print shell export lines and optionally append to `~/.zshrc`.
//!   5. Generate and write the launchd plist.
//!   6. Print a setup summary.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

/// Entry point called from `main.rs` when `--setup` is passed.
pub fn run() -> anyhow::Result<()> {
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
    if creds_path.exists() {
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
    print!("Add to ~/.zshrc now? [Y/n]: ");
    io::stdout().flush()?;

    let answer = read_line()?;
    let answer = answer.trim().to_lowercase();
    if answer.is_empty() || answer == "y" || answer == "yes" {
        append_to_zshrc(&home, &export_lines)?;
        println!("✓ Lines appended to ~/.zshrc");
    } else {
        println!("  Skipped — add them manually when ready.");
    }

    // ── Step 5: Launchd plist ──────────────────────────────────────────
    let binary_path = current_binary_path();
    let plist_xml = generate_launchd_plist(&binary_path, &config_dir, &home);
    let launch_agents = home.join("Library").join("LaunchAgents");
    std::fs::create_dir_all(&launch_agents)?;
    let plist_path = launch_agents.join("com.sci.helper.plist");
    std::fs::write(&plist_path, plist_xml)?;

    println!();
    println!("Launchd plist written to {}", plist_path.display());
    println!();
    println!("To start Sci on login:");
    println!("  launchctl load ~/Library/LaunchAgents/com.sci.helper.plist");
    println!("To start now:");
    println!("  launchctl start com.sci.helper");

    // ── Step 6: Summary ────────────────────────────────────────────────
    println!();
    println!("─── Setup summary ───────────────────────────────────────────────");
    println!("  Config dir     : {}", config_dir.display());
    println!("  Memory dir     : {}", memory_dir.display());
    println!("  Credentials    : {}", creds_path.display());
    println!("  Launchd plist  : {}", plist_path.display());
    println!();
    println!("Next steps:");
    if !ca_path.exists() {
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
        // Without this, `brew update` routes through sci-helper before it
        // is running and fails with a connection-refused error.
        "export NO_PROXY=localhost,127.0.0.1,*.brew.sh,formulae.brew.sh,raw.githubusercontent.com,objects.githubusercontent.com".to_string(),
    ]
}

fn append_to_zshrc(home: &Path, lines: &[String]) -> anyhow::Result<()> {
    let zshrc = home.join(".zshrc");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&zshrc)?;
    writeln!(file)?;
    writeln!(file, "# Added by sci-helper --setup")?;
    for line in lines {
        writeln!(file, "{line}")?;
    }
    Ok(())
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
