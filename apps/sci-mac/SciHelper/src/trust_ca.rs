//! `sci-helper --trust-ca` — add the Sci CA to the macOS system keychain.
//!
//! Runs:
//!   security add-trusted-cert -r trustRoot \
//!     -k ~/Library/Keychains/login.keychain-db \
//!     ~/.sci/ca.crt
//!
//! On success, prints a confirmation. On failure, prints the stderr from
//! `security` and a hint about sudo / Keychain Access.

use std::path::PathBuf;
use std::process::Command;

/// Entry point called from `main.rs` when `--trust-ca` is passed.
pub fn run() -> anyhow::Result<()> {
    let home = home_dir()?;
    let ca_path = home.join(".sci").join("ca.crt");

    // ── Guard: CA must exist ───────────────────────────────────────────
    if !ca_path.exists() {
        eprintln!(
            "CA not found at {} — run sci-helper --proxy once to generate it, \
             then run --trust-ca",
            ca_path.display()
        );
        std::process::exit(1);
    }

    // ── Run security(1) ───────────────────────────────────────────────
    let keychain = home
        .join("Library")
        .join("Keychains")
        .join("login.keychain-db");

    let output = Command::new("security")
        .args([
            "add-trusted-cert",
            "-r", "trustRoot",
            "-k", keychain.to_str().unwrap_or("~/Library/Keychains/login.keychain-db"),
            ca_path.to_str().unwrap_or("~/.sci/ca.crt"),
        ])
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run `security`: {e}"))?;

    if output.status.success() {
        println!("✓ Sci CA trusted. HTTPS interception will work for all tools.");
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            eprintln!("{}", stderr.trim_end());
        }
        eprintln!(
            "If you see 'permission denied', try running with sudo once, \
             or add via Keychain Access manually."
        );
        let code = output.status.code().unwrap_or(1);
        std::process::exit(code);
    }

    Ok(())
}

fn home_dir() -> anyhow::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| anyhow::anyhow!("$HOME is not set"))?;
    Ok(PathBuf::from(home))
}
