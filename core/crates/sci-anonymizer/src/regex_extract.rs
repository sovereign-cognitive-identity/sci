//! Regex + CamelCase entity passes.
//!
//! The TypeScript reference uses lookbehind / lookahead in two patterns
//! (bare-domain and social-handle) that Rust's `regex` crate doesn't
//! support. We do the same matching with a coarser regex + a manual
//! boundary check on the byte preceding the match — same semantics,
//! same `regex` crate, no `fancy-regex` dependency.

use crate::allowlist::is_allowlisted;
use crate::token_map::{Entity, EntityType};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

// ── Regexes ────────────────────────────────────────────────────────────────
//
// All patterns compiled once. The TS originals live next to each Rust
// pattern in a comment so a side-by-side review stays tractable when
// somebody adds a new entity type.

// /https?:\/\/[^\s,)>'"]+/g
static URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"https?://[^\s,)>'"]+"#).unwrap());

// /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap());

// TS: /(?<![.@a-zA-Z0-9])\b[a-zA-Z0-9-]{3,}\.(com|io|ai|dev|app|net|org|co)\b/g
// Rust loses the lookbehind. We match the body and check the preceding
// byte by hand in `not_preceded_by`.
static DOMAIN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b[a-zA-Z0-9\-]{3,}\.(?:com|io|ai|dev|app|net|org|co)\b").unwrap()
});

// TS: /(?<![a-zA-Z0-9.])@[a-zA-Z][a-zA-Z0-9_]{2,}/g
// Same lookbehind story.
static HANDLE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"@[a-zA-Z][a-zA-Z0-9_]{2,}").unwrap());

// /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
static PHONE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:\+?1[\-.\s]?)?\(?\d{3}\)?[\-.\s]?\d{3}[\-.\s]?\d{4}\b").unwrap()
});

// /\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b/g — true compound CamelCase only.
// Single-cap words like `Casey` or `Tulsa` are NOT caught here; they
// flow through NLP NER (SCI-123).
static CAMEL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b").unwrap());

// API tokens / secrets: a short lowercase prefix (1–12 chars) followed by
// an underscore and 20+ alphanumeric characters.
// Catches: cfut_..., sk-..., ghp_..., ATT..., xoxb-..., pat_..., etc.
// Also catches bare long random strings (32+ chars of mixed case + digits)
// that look like secrets even without a recognisable prefix.
static SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:[a-zA-Z0-9]{1,12}[_\-])[A-Za-z0-9+/]{20,}|[A-Za-z0-9]{32,}").unwrap()
});

// IPv4 addresses — four octet groups separated by dots.
static IPV4_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b").unwrap()
});

// ── Helpers ────────────────────────────────────────────────────────────────

/// Return true if the byte at `text[idx-1]` is NOT in `forbidden`.
/// Mimics a JS lookbehind. `idx == 0` is treated as "no preceding char,"
/// which the lookbehind would also accept.
fn not_preceded_by(text: &str, idx: usize, forbidden: &[u8]) -> bool {
    if idx == 0 {
        return true;
    }
    // Walk back one UTF-8 char. Most of our regexes operate over ASCII
    // contexts (URLs, handles), so a byte-step is safe in practice — but
    // we still guard against splitting a multi-byte char by walking until
    // we land on a char boundary.
    let mut prev = idx - 1;
    while !text.is_char_boundary(prev) && prev > 0 {
        prev -= 1;
    }
    let b = text.as_bytes()[prev];
    !forbidden.contains(&b)
}

// ── Pass 1: regex entities ─────────────────────────────────────────────────

pub fn extract_regex_entities(text: &str) -> Vec<Entity> {
    let mut entities: Vec<Entity> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // Tracks character indices already consumed by an earlier (higher-
    // priority) match. Used to suppress sub-matches — e.g. if a URL
    // claims indices 10..40 we don't also let the bare-domain regex
    // grab `example.com` from inside it.
    let mut consumed: HashSet<usize> = HashSet::new();

    let add = |t: &str,
                   ty: EntityType,
                   idx: Option<usize>,
                   entities: &mut Vec<Entity>,
                   seen: &mut HashSet<String>,
                   consumed: &mut HashSet<usize>| {
        let n = t.trim();
        if n.len() < 3 {
            return;
        }
        let key = n.to_lowercase();
        if seen.contains(&key) {
            return;
        }
        seen.insert(key);
        entities.push(Entity {
            text: n.to_string(),
            entity_type: ty,
        });
        if let Some(start) = idx {
            for i in start..start + n.len() {
                consumed.insert(i);
            }
        }
    };

    // 1) URLs first — most specific, most consumption.
    for m in URL_RE.find_iter(text) {
        add(
            m.as_str(),
            EntityType::Url,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 2) Emails — before bare domains so `foo@bar.com` doesn't get split.
    for m in EMAIL_RE.find_iter(text) {
        add(
            m.as_str(),
            EntityType::Email,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 3) Bare domains — the TS lookbehind says: not preceded by '.', '@',
    // or alphanumeric. Replicate manually, AND skip anything inside an
    // already-consumed range (catches the inside-URL case directly).
    let domain_forbidden: &[u8] = b".@";
    for m in DOMAIN_RE.find_iter(text) {
        if consumed.contains(&m.start()) {
            continue;
        }
        if !not_preceded_by(text, m.start(), domain_forbidden) {
            continue;
        }
        // Also reject if the preceding byte is alphanumeric — the TS
        // lookbehind explicitly disallows `[.@a-zA-Z0-9]`.
        if m.start() > 0 {
            let prev = text.as_bytes()[m.start() - 1];
            if prev.is_ascii_alphanumeric() {
                continue;
            }
        }
        add(
            m.as_str(),
            EntityType::Url,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 4) Social handles — TS lookbehind: not preceded by alphanumeric or
    // dot. Same boundary check approach.
    for m in HANDLE_RE.find_iter(text) {
        if consumed.contains(&m.start()) {
            continue;
        }
        if m.start() > 0 {
            let prev = text.as_bytes()[m.start() - 1];
            if prev.is_ascii_alphanumeric() || prev == b'.' {
                continue;
            }
        }
        add(
            m.as_str(),
            EntityType::Handle,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 5) Phone numbers — TS doesn't track consumption for phones because
    // overlap with the earlier patterns is functionally impossible.
    for m in PHONE_RE.find_iter(text) {
        add(
            m.as_str(),
            EntityType::Phone,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 6) IPv4 addresses — must come before SECRET_RE so a bare IP like
    // 194.238.29.36 isn't vacuumed up by the long-digit heuristic.
    for m in IPV4_RE.find_iter(text) {
        if consumed.contains(&m.start()) {
            continue;
        }
        add(
            m.as_str(),
            EntityType::IpAddress,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    // 7) API tokens and long secrets.  Skip anything already consumed (URLs,
    // emails, etc. can contain long alphanumeric runs we've already masked).
    for m in SECRET_RE.find_iter(text) {
        if consumed.contains(&m.start()) {
            continue;
        }
        // Reject common false-positives: hex colours (#ffffff…), long words
        // that are just prose, things already in the allowlist.
        let s = m.as_str();
        if is_allowlisted(s) {
            continue;
        }
        // Require a minimum entropy signal: at least one digit AND one letter
        // in the random portion (pure-alpha or pure-digit runs are usually
        // prose or numbers, not secrets).
        let has_digit  = s.bytes().any(|b| b.is_ascii_digit());
        let has_alpha  = s.bytes().any(|b| b.is_ascii_alphabetic());
        if !(has_digit && has_alpha) {
            continue;
        }
        add(
            s,
            EntityType::Secret,
            Some(m.start()),
            &mut entities,
            &mut seen,
            &mut consumed,
        );
    }

    entities
}

// ── Pass 4: CamelCase heuristic ───────────────────────────────────────────
//
// Pass-2 (NLP NER) populates `known_entities` with PERSON/PLACE/ORG
// matches; this pass refuses anything that's already been claimed. Until
// SCI-123 lands the NER, callers pass an empty set.

pub fn extract_camelcase_entities(text: &str, known_entities: &HashSet<String>) -> Vec<Entity> {
    let mut entities: Vec<Entity> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for m in CAMEL_RE.find_iter(text) {
        let term = m.as_str();
        if is_allowlisted(term) {
            continue;
        }
        let key = term.to_lowercase();
        if known_entities.contains(&key) || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        entities.push(Entity {
            text: term.to_string(),
            entity_type: EntityType::Project,
        });
    }

    entities
}
