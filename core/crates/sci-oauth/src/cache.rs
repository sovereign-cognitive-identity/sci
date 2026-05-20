//! Token cache — `~/.sci/oauth.json`, mode 0600.
//!
//! On-disk shape is bytewise-compatible with the TS implementation
//! at `packages/proxy/src/upstream-auth.ts` (which writes the same
//! file). Field ordering is the same, all fields are optional/nullable
//! the same way, so a user can move between TS proxy and Rust core
//! without re-authenticating.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Mirror of the TS `TokenInfo`. `serde_json::Value` for `organization`
/// and `account` because Anthropic's payload there is opaque + may
/// change shape across model versions; we just round-trip it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    pub access_token:  String,
    pub refresh_token: String,
    /// Absolute UNIX-epoch millis. `None` if Anthropic didn't return
    /// `expires_in` (rare; treat as "never expires" until a 401 forces
    /// a refresh).
    pub expires_at_ms: Option<i64>,
    pub scope:         String,
    pub organization:  Option<serde_json::Value>,
    pub account:       Option<serde_json::Value>,
    pub token_uuid:    Option<String>,
}

/// Default cache path: `~/.sci/oauth.json`. Override via the
/// `SCI_OAUTH_CACHE_PATH` env var (used in tests).
pub fn cache_path() -> PathBuf {
    if let Ok(p) = std::env::var("SCI_OAUTH_CACHE_PATH") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".sci").join("oauth.json")
}

/// Load the cached `TokenInfo`. Returns `Ok(None)` if the file
/// doesn't exist or fails to parse — a failed parse is treated the
/// same as "no cache" rather than an error, because the only useful
/// recovery is the same: prompt the user to re-login.
pub fn read_cache() -> crate::Result<Option<TokenInfo>> {
    let path = cache_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)?;
    match serde_json::from_str::<TokenInfo>(&text) {
        Ok(info) => Ok(Some(info)),
        Err(_) => Ok(None),  // corrupt cache → re-login
    }
}

pub(crate) fn write_cache(info: &TokenInfo) -> crate::Result<()> {
    let path = cache_path();
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        fs::create_dir_all(parent)?;
        set_dir_mode_0700(parent)?;
    }
    let json = serde_json::to_string_pretty(info)?;
    let mut f = fs::File::create(&path)?;
    f.write_all(json.as_bytes())?;
    set_file_mode_0600(&path)?;
    Ok(())
}

pub fn delete_cache() -> crate::Result<()> {
    let path = cache_path();
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_file_mode_0600(path: &Path) -> crate::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(unix)]
fn set_dir_mode_0700(path: &Path) -> crate::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    fs::set_permissions(path, perms)?;
    Ok(())
}

// Windows: best-effort only. NTFS ACLs aren't reachable from std without
// crates we'd rather not pull in; users on Windows should rely on the
// per-user profile-dir ACL inheriting to ~\.sci\oauth.json. Acceptable
// for v0.5.
#[cfg(not(unix))]
fn set_file_mode_0600(_path: &Path) -> crate::Result<()> { Ok(()) }
#[cfg(not(unix))]
fn set_dir_mode_0700(_path: &Path) -> crate::Result<()> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_cache_path() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oauth.json");
        // SAFETY: tests run single-threaded by default; setting an env
        // var here is fine in our context.
        unsafe { std::env::set_var("SCI_OAUTH_CACHE_PATH", path.to_str().unwrap()); }
        dir
    }

    #[test]
    #[serial_test::serial]
    fn round_trip_token_info() {
        let _dir = isolated_cache_path();
        assert!(read_cache().unwrap().is_none(), "fresh dir should be empty");

        let original = TokenInfo {
            access_token:  "access".into(),
            refresh_token: "refresh".into(),
            expires_at_ms: Some(1_700_000_000_000),
            scope:         "user:profile user:inference".into(),
            organization:  Some(serde_json::json!({"id":"org-1"})),
            account:       None,
            token_uuid:    Some("uuid-abc".into()),
        };
        write_cache(&original).unwrap();
        let loaded = read_cache().unwrap().unwrap();
        assert_eq!(loaded.access_token, original.access_token);
        assert_eq!(loaded.refresh_token, original.refresh_token);
        assert_eq!(loaded.scope, original.scope);
        assert_eq!(loaded.token_uuid, original.token_uuid);
    }

    #[test]
    #[serial_test::serial]
    fn delete_removes_file() {
        let _dir = isolated_cache_path();
        let info = TokenInfo {
            access_token:  "x".into(),
            refresh_token: "y".into(),
            expires_at_ms: None,
            scope:         String::new(),
            organization:  None,
            account:       None,
            token_uuid:    None,
        };
        write_cache(&info).unwrap();
        assert!(read_cache().unwrap().is_some());
        delete_cache().unwrap();
        assert!(read_cache().unwrap().is_none());
    }

    #[test]
    #[serial_test::serial]
    fn corrupt_cache_returns_none_not_error() {
        let _dir = isolated_cache_path();
        let path = cache_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not json").unwrap();
        let r = read_cache().unwrap();
        assert!(r.is_none(), "corrupt cache should be treated as missing");
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial]
    fn cache_file_is_mode_0600() {
        let _dir = isolated_cache_path();
        let info = TokenInfo {
            access_token:  "x".into(),
            refresh_token: "y".into(),
            expires_at_ms: None,
            scope:         String::new(),
            organization:  None,
            account:       None,
            token_uuid:    None,
        };
        write_cache(&info).unwrap();
        let mode = fs::metadata(cache_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "cache file should be 0600, got 0{:o}", mode);
    }
}
