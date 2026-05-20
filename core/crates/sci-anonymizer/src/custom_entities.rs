//! Custom-entity loader (SCI-124).
//!
//! Port of TS `extractEntitiesFromFacts` in
//! `packages/core/src/anonymizer.ts` (lines ~86-150). The TS pipeline's
//! pass-3 reads `identity_facts` rows from the storage adapter, mines
//! them for project/org names a generic NER won't catch (e.g.
//! `Threadline` — single-cap, not a CamelCase compound, not in any
//! lexicon), and feeds the harvest back into anonymization.
//!
//! Four sub-passes, run on each fact's `content` field:
//!
//!   1. Backtick-quoted terms — ``` `Threadline` ```, ``` `OpenClaw` ```.
//!      Length ≥ 4, not all-lowercase, not in allowlist.
//!   2. Single-/double-quoted Proper Nouns — `"Sci"`, `'Threadline'`.
//!      Max two words, must start with a capital.
//!   3. CamelCase — same regex as `regex_extract::extract_camelcase_entities`,
//!      but inside fact content rather than the prompt.
//!   4. Emails — picked out of fact content and tagged EMAIL.
//!
//! The category on the fact (`project` / `context` / `skill` /
//! `relationship`) decides whether quoted/CamelCase entries get tagged
//! PROJECT or ORG. Backtick-quoted is always PROJECT (TS convention).
//!
//! Caller composition (intentionally one-way):
//!
//!   `sci-memory::LocalAdapter::query_identity_facts(...)` →
//!   `extract_entities_from_facts(...)` →
//!   `anonymize_with_custom(prompt, existing_map, custom_entities)`
//!
//! Anonymizer doesn't depend on `sci-memory` directly; the platform
//! shell (or a future `sci-pipeline` crate) wires the pieces.

use crate::allowlist::is_allowlisted;
use crate::token_map::{Entity, EntityType};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

/// One row's worth of input. Shape mirrors what
/// `sci-memory::LocalAdapter::query_identity_facts` returns, minus
/// the bookkeeping fields the loader doesn't need (id, confidence,
/// timestamps, metadata).
#[derive(Debug, Clone)]
pub struct Fact<'a> {
    pub content:  &'a str,
    /// Lower-cased category string. `"project"`, `"context"`, etc.
    /// `None` is treated as `"context"` for the OR-tag-decision rule.
    pub category: Option<&'a str>,
}

// ── Regexes ──────────────────────────────────────────────────────────────

// /`([A-Za-z][a-zA-Z0-9._@/-]{2,})`/g
static BACKTICK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"`([A-Za-z][a-zA-Z0-9._@/\-]{2,})`").unwrap());

// /['"]([A-Z][a-zA-Z0-9 ._-]{2,})['"]/g
// Rust regex doesn't support character classes inside (?: ) the same
// way as JS, so split into two regexes (single + double quote) and
// take the union.
static SINGLE_QUOTED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"'([A-Z][a-zA-Z0-9 ._\-]{2,})'").unwrap());
static DOUBLE_QUOTED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""([A-Z][a-zA-Z0-9 ._\-]{2,})""#).unwrap());

// /\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b/g  — same as regex_extract.rs
static CAMEL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b").unwrap());

// /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap());

// ── Public entry ─────────────────────────────────────────────────────────

/// Extract custom entities from a slice of identity facts.
///
/// The TS reference filters its `seen` set on lower-cased keys; we
/// match that so the same content + same fact set produces the same
/// entity list across implementations.
pub fn extract_entities_from_facts(facts: &[Fact<'_>]) -> Vec<Entity> {
    let mut entities = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for fact in facts {
        // Decide whether quoted + CamelCase entities tag as PROJECT
        // or ORG. TS rule: `category === 'project'` → PROJECT, else
        // ORG. Backtick-quoted is always PROJECT.
        let cat = fact.category.unwrap_or("context");
        let project_or_org = if cat == "project" {
            EntityType::Project
        } else {
            EntityType::Org
        };

        // 1. Backtick-quoted ─────────────────────────────────────────────
        for m in BACKTICK_RE.captures_iter(fact.content) {
            // capture group 1 is the inner text without the backticks
            let raw = m.get(1).map(|m| m.as_str()).unwrap_or("");
            // First path segment, strip leading @, drop the literal
            // string "sci" (TS hardcodes this skip — Sci itself never
            // appears in user-visible content as a project name we'd
            // mask).
            let term = raw.split('/').next().unwrap_or("");
            let term = term.strip_prefix('@').unwrap_or(term);
            if term == "sci" || term.is_empty() {
                continue;
            }
            if term.len() < 4
                || term == term.to_lowercase()
                || is_allowlisted(term)
            {
                continue;
            }
            let key = term.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            entities.push(Entity {
                text:        term.to_string(),
                entity_type: EntityType::Project,
            });
        }

        // 2. Quoted proper nouns (single + double) ───────────────────────
        for re in [&*SINGLE_QUOTED_RE, &*DOUBLE_QUOTED_RE] {
            for m in re.captures_iter(fact.content) {
                let raw = m.get(1).map(|m| m.as_str()).unwrap_or("");
                let term = raw.trim();
                if term.is_empty() {
                    continue;
                }
                let word_count = term.split_whitespace().count();
                if word_count > 2 || is_allowlisted(term) {
                    continue;
                }
                let key = term.to_lowercase();
                if seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                entities.push(Entity {
                    text:        term.to_string(),
                    entity_type: project_or_org,
                });
            }
        }

        // 3. CamelCase ───────────────────────────────────────────────────
        for m in CAMEL_RE.find_iter(fact.content) {
            let term = m.as_str();
            if is_allowlisted(term) {
                continue;
            }
            let key = term.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            entities.push(Entity {
                text:        term.to_string(),
                entity_type: project_or_org,
            });
        }

        // 4. Emails ──────────────────────────────────────────────────────
        for m in EMAIL_RE.find_iter(fact.content) {
            let term = m.as_str();
            let key = term.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            entities.push(Entity {
                text:        term.to_string(),
                entity_type: EntityType::Email,
            });
        }
    }

    entities
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(content: &str, category: &str) -> Vec<Entity> {
        extract_entities_from_facts(&[Fact {
            content,
            category: Some(category),
        }])
    }

    #[test]
    fn backtick_project() {
        let out = run("Working on `Threadline` this week.", "project");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "Threadline");
        assert_eq!(out[0].entity_type, EntityType::Project);
    }

    #[test]
    fn backtick_skips_lowercase_cli_command() {
        // `grep` is a CLI command, all-lowercase — TS rule skips it.
        let out = run("Use `grep` to filter the output.", "project");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn backtick_skips_short_term() {
        // `npm` is in TECH_ALLOWLIST anyway, but the length filter is
        // a separate guard worth pinning.
        let out = run("Run `Foo` to test.", "project");
        // "Foo" is length 3, fails the >= 4 filter.
        assert!(out.is_empty());
    }

    #[test]
    fn backtick_splits_path() {
        // The backtick regex requires an alpha first char (TS quirk),
        // so no leading `@`. After splitting on `/`, "MyOrg" survives
        // the filters: length ≥ 4, mixed case, not allowlisted.
        let out = run("Pull `MyOrg/my-package` instead.", "project");
        assert_eq!(out.len(), 1, "got: {:?}", out);
        assert_eq!(out[0].text, "MyOrg");
    }

    #[test]
    fn double_quoted_proper_noun() {
        let out = run(r#"The codename was "Threadline" — kept secret."#, "project");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "Threadline");
        assert_eq!(out[0].entity_type, EntityType::Project);
    }

    #[test]
    fn quoted_with_two_words() {
        let out = run("'Serious Hobbyist' is the persona.", "context");
        // <= 2 words, both capitalized, OK.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "Serious Hobbyist");
        assert_eq!(out[0].entity_type, EntityType::Org);
    }

    #[test]
    fn quoted_with_three_words_skipped() {
        // TS rule: word_count > 2 → skip. Catches accidental phrase
        // tagging like 'Push to Jira'.
        let out = run("'Push to Jira' is the workflow.", "context");
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn camelcase_in_fact() {
        let out = run("OpenClaw runs on a MacBook.", "project");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "OpenClaw");
        assert_eq!(out[0].entity_type, EntityType::Project);
        // MacBook is allowlisted, doesn't appear.
    }

    #[test]
    fn email_in_fact() {
        let out = run("Casey's email is casey@example.com.", "context");
        let emails: Vec<_> = out
            .iter()
            .filter(|e| e.entity_type == EntityType::Email)
            .collect();
        assert_eq!(emails.len(), 1);
        assert_eq!(emails[0].text, "casey@example.com");
    }

    #[test]
    fn dedup_across_facts() {
        // Two facts both mention OpenClaw — should produce one entity.
        let out = extract_entities_from_facts(&[
            Fact { content: "OpenClaw is the project.", category: Some("project") },
            Fact { content: "Working on OpenClaw today.", category: Some("project") },
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "OpenClaw");
    }

    #[test]
    fn category_decides_project_vs_org() {
        let proj = run(r#""Threadline" is what."#, "project");
        let ctx  = run(r#""Threadline" is what."#, "context");
        assert_eq!(proj[0].entity_type, EntityType::Project);
        assert_eq!(ctx[0].entity_type, EntityType::Org);
    }

    #[test]
    fn skips_literal_sci() {
        // TS hardcodes `'sci'` to be skipped from backtick tagging.
        let out = run("The repo is `sci`.", "project");
        assert!(out.is_empty(), "got: {:?}", out);
    }
}
