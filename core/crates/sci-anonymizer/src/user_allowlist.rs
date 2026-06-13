//! Per-user allowlist — terms the user explicitly does NOT want masked (inverse of custom-entity loader).
//!
//! Mirrors `UserAllowlist` concept in `packages/core/src/user-allowlist.ts`.
//! When a detected entity matches the allowlist, it is excluded from the token map
//! and left verbatim in the outbound text (allowlist takes precedence over detection).

use std::collections::HashSet;

/// Per-user allowlist of terms that should never be masked.
/// Case-insensitive: stores terms in lowercase for comparison.
#[derive(Debug, Clone)]
pub struct UserAllowlist {
    terms: HashSet<String>,
}

impl UserAllowlist {
    /// Create a new allowlist from a collection of terms.
    /// Terms are normalized to lowercase for case-insensitive matching.
    pub fn new(terms: impl IntoIterator<Item = String>) -> Self {
        UserAllowlist {
            terms: terms.into_iter().map(|t| t.to_lowercase()).collect(),
        }
    }

    /// Create an empty allowlist.
    pub fn empty() -> Self {
        UserAllowlist {
            terms: HashSet::new(),
        }
    }

    /// Check if a term is allowlisted (case-insensitive exact match).
    pub fn contains(&self, term: &str) -> bool {
        self.terms.contains(&term.to_lowercase())
    }

    /// Return the number of terms in the allowlist.
    pub fn len(&self) -> usize {
        self.terms.len()
    }

    /// Check if the allowlist is empty.
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

/// Convenience function for case-insensitive allowlist check.
/// Returns true if the term is in the allowlist.
pub fn is_user_allowlisted(term: &str, allowlist: &UserAllowlist) -> bool {
    allowlist.contains(term)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_allowlist() {
        let terms = vec!["Threadline".to_string(), "OpenClaw".to_string()];
        let allowlist = UserAllowlist::new(terms);
        assert_eq!(allowlist.len(), 2);
    }

    #[test]
    fn case_insensitive_match() {
        let terms = vec!["Threadline".to_string()];
        let allowlist = UserAllowlist::new(terms);

        assert!(allowlist.contains("Threadline"));
        assert!(allowlist.contains("threadline"));
        assert!(allowlist.contains("THREADLINE"));
    }

    #[test]
    fn not_in_allowlist() {
        let terms = vec!["Threadline".to_string()];
        let allowlist = UserAllowlist::new(terms);
        assert!(!allowlist.contains("OpenClaw"));
    }

    #[test]
    fn empty_allowlist() {
        let allowlist: UserAllowlist = UserAllowlist::empty();
        assert!(allowlist.is_empty());
        assert!(!allowlist.contains("Threadline"));
    }

    #[test]
    fn convenience_function() {
        let terms = vec!["Casey".to_string()];
        let allowlist = UserAllowlist::new(terms);
        assert!(is_user_allowlisted("casey", &allowlist));
        assert!(!is_user_allowlisted("Blake", &allowlist));
    }
}
