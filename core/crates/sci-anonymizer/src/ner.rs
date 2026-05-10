//! Lexicon + grammar NER (SCI-123).
//!
//! Replaces the TS pipeline's compromise.js pass-2. compromise has a
//! built-in lexicon + POS tagger; we do the same in Rust with hand-
//! curated lexicons (`data/first_names.txt`, `data/places.txt`) plus
//! a small set of grammatical rules:
//!
//!   - Honorific + Capitalized → PERSON
//!     "Dr. Casey", "Mrs. Smith", "Prof. Adams"
//!   - First-name + Capitalized → PERSON (compound)
//!     "Casey Zandbergen", "Mary Stewart"
//!   - First-name (alone) → PERSON
//!     "Casey said …"
//!   - Place lexicon hit → PLACE
//!     "Tulsa", "California", "London"
//!   - "Word, ST" or "Word, Country" → PLACE for both halves
//!     "Tulsa, OK", "Lyon, France"
//!   - Capitalized + (Inc|Corp|LLC|Ltd|Co.|AG|GmbH) → ORG
//!     "Anthropic Inc", "OpenAI Corp"
//!
//! What this *doesn't* catch:
//!
//!   - Single-cap proper nouns NOT in the lexicons (e.g. someone
//!     named "Aabbiis"). Compromise wouldn't catch them either; the
//!     v0.5 tradeoff is "ship something that catches 90% of common
//!     names" rather than "ship a 440 MB BERT NER model." When the
//!     lexicon misses, the user's session feedback loop (TS pass-3,
//!     Rust SCI-124 custom-entity loader) escalates the entity as it
//!     accumulates appearances.
//!   - Nuanced cases compromise gets right via deeper POS analysis
//!     (e.g. "Hope" the proper noun vs "hope" the common noun
//!     ambiguated by sentence context). Our lexicons exclude common-
//!     word names (`Will`, `April`, `May`, etc.) on purpose.
//!
//! Allowlist: every detected entity is filtered through `is_allowlisted`
//! after lexicon match. Pre-filtering at the lexicon level was cleaner
//! but lookups against the allowlist are sub-microsecond, so the cost
//! of the after-the-fact filter is negligible.

use crate::allowlist::is_allowlisted;
use crate::token_map::{Entity, EntityType};
use once_cell::sync::Lazy;
use std::collections::HashSet;

// ── Lexicons ──────────────────────────────────────────────────────────────

const FIRST_NAMES_RAW: &str = include_str!("data/first_names.txt");
const PLACES_RAW:      &str = include_str!("data/places.txt");

/// Set of lower-cased first names. ~500 entries.
static FIRST_NAMES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    parse_lexicon(FIRST_NAMES_RAW)
});

/// Set of lower-cased place names. Multi-word entries like
/// `"new york"` are present as full strings; the tokenizer slides a
/// bigram window to match them.
static PLACES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    parse_lexicon(PLACES_RAW)
});

/// Subset of `PLACES` containing only single-token entries — used by
/// the unigram-token pass for fast lookup. Two-token places get a
/// dedicated bigram pass.
static PLACES_UNIGRAM: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    PLACES
        .iter()
        .filter(|s| !s.contains(' '))
        .copied()
        .collect()
});

static PLACES_BIGRAM: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    PLACES.iter().filter(|s| s.contains(' ')).copied().collect()
});

/// Honorifics that mark the next token(s) as PERSON regardless of
/// whether they're in the first-names lexicon. `.` and trailing
/// period handled by the tokenizer.
static HONORIFICS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "mr", "mrs", "ms", "miss", "dr", "prof", "professor",
        "sir", "madam", "ma'am", "lord", "lady", "fr", "rev", "rabbi",
    ]
    .into_iter()
    .collect()
});

/// Suffixes that mark the preceding capitalized chunk as an ORG.
/// Period-trimmed on input. Lower-cased for comparison.
static ORG_SUFFIXES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "inc", "corp", "llc", "co", "ltd", "ag", "gmbh", "sa", "plc",
        "lp", "llp", "kk",
    ]
    .into_iter()
    .collect()
});

fn parse_lexicon(raw: &'static str) -> HashSet<&'static str> {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

// ── Tokenizer ─────────────────────────────────────────────────────────────
//
// We keep punctuation attached to its preceding word — it's useful for
// rule recognition (e.g. "X," signals the X-comma-state pattern). The
// matching code strips trailing punctuation as needed.

#[derive(Debug, Clone)]
struct Token<'a> {
    /// The original text slice, including any trailing punctuation.
    raw:     &'a str,
    /// Lowercased version with trailing punctuation stripped.
    norm:    String,
    /// Original-case version with trailing punctuation stripped.
    /// Preserved so we can emit Entity.text in the user's casing.
    surface: &'a str,
    /// Was the original (untrimmed) token capitalized?
    is_cap:  bool,
}

fn tokenize(text: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        // Strip trailing punctuation for the canonical form, but keep
        // the raw slice for rules that look at it (e.g. comma-aware
        // place rule).
        let trimmed_end = raw.trim_end_matches(|c: char| c.is_ascii_punctuation() && c != '\'');
        // Also strip leading quotes / parens.
        let surface = trimmed_end.trim_start_matches(['(', '[', '"', '\'']);
        if surface.is_empty() {
            continue;
        }
        let is_cap = surface.chars().next().is_some_and(|c| c.is_ascii_uppercase());
        out.push(Token {
            raw,
            norm: surface.to_lowercase(),
            surface,
            is_cap,
        });
    }
    out
}

// ── Public entry ──────────────────────────────────────────────────────────

/// Extract PERSON / PLACE / ORG entities from a free-text input. Mirrors
/// the role of compromise.js's `nlp(text).people() / .places() / .organizations()`
/// in `packages/core/src/anonymizer.ts`'s `extractNlpEntities`.
///
/// The output is intentionally noisy at the lexicon level — every
/// match enters the candidate set. The final dedup + allowlist filter
/// happens at the bottom of this function before returning.
pub fn extract_nlp_entities(text: &str) -> Vec<Entity> {
    let toks = tokenize(text);
    let mut out: Vec<Entity> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let push = |entities: &mut Vec<Entity>,
                seen: &mut HashSet<String>,
                text: String,
                ty: EntityType| {
        if text.len() < 2 {
            return;
        }
        let key = text.to_lowercase();
        if seen.contains(&key) {
            return;
        }
        if is_allowlisted(&text) {
            return;
        }
        seen.insert(key);
        entities.push(Entity { text, entity_type: ty });
    };

    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];

        // ── 1. Honorific → PERSON ────────────────────────────────────────
        // "Dr. Casey", "Mrs. Smith Jones". Strip trailing period from
        // the honorific token for lexicon match.
        let honorific_norm = t.norm.trim_end_matches('.');
        if HONORIFICS.contains(honorific_norm) && i + 1 < toks.len() && toks[i + 1].is_cap {
            // Greedy: consume capitalized tokens following the honorific.
            // Cap at 3 to avoid runaway matches.
            let j = i + 1;
            let start_surface = toks[j].surface;
            let mut end_idx = j;
            while end_idx < toks.len()
                && end_idx < j + 3
                && toks[end_idx].is_cap
            {
                end_idx += 1;
            }
            let span = surface_span(text, start_surface, &toks[end_idx - 1]);
            push(&mut out, &mut seen, span, EntityType::Person);
            i = end_idx;
            continue;
        }

        // Skip non-cap tokens for the rest of the rules — they don't
        // trigger any of the remaining patterns.
        if !t.is_cap {
            i += 1;
            continue;
        }

        // ── 2. First-name lexicon → PERSON ───────────────────────────────
        // "Casey said …", "Casey Zandbergen visited …".
        if FIRST_NAMES.contains(t.norm.as_str()) && !is_allowlisted(t.surface) {
            // Compound: if next token is also capitalized, take both.
            if i + 1 < toks.len() && toks[i + 1].is_cap && !is_allowlisted(toks[i + 1].surface) {
                // Don't extend if the next token is itself an org
                // suffix or place — those have their own rules below.
                let next_norm_clean = toks[i + 1].norm.trim_end_matches('.');
                let extends = !ORG_SUFFIXES.contains(next_norm_clean)
                    && !PLACES_UNIGRAM.contains(toks[i + 1].norm.as_str());
                if extends {
                    let span = surface_span(text, t.surface, &toks[i + 1]);
                    push(&mut out, &mut seen, span, EntityType::Person);
                    i += 2;
                    continue;
                }
            }
            push(&mut out, &mut seen, t.surface.to_string(), EntityType::Person);
            i += 1;
            continue;
        }

        // ── 3. Bigram place ─────────────────────────────────────────────
        // "New York", "San Francisco". Two consecutive cap-cap tokens
        // whose lowercase concatenation is in `PLACES_BIGRAM`.
        if i + 1 < toks.len() && toks[i + 1].is_cap {
            let bigram = format!("{} {}", t.norm, toks[i + 1].norm);
            if PLACES_BIGRAM.contains(bigram.as_str()) {
                let span = surface_span(text, t.surface, &toks[i + 1]);
                push(&mut out, &mut seen, span, EntityType::Place);
                i += 2;
                continue;
            }
        }

        // ── 4. Unigram place ─────────────────────────────────────────────
        if PLACES_UNIGRAM.contains(t.norm.as_str()) && !is_allowlisted(t.surface) {
            push(&mut out, &mut seen, t.surface.to_string(), EntityType::Place);
            // Also catch "X, ST" — if next token (after stripping comma
            // from this one OR being a separate token) is a state abbr.
            if t.raw.ends_with(',')
                && i + 1 < toks.len()
                && PLACES_UNIGRAM.contains(toks[i + 1].norm.as_str())
            {
                push(
                    &mut out,
                    &mut seen,
                    toks[i + 1].surface.to_string(),
                    EntityType::Place,
                );
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        // ── 5. ORG via suffix ────────────────────────────────────────────
        // "Anthropic Inc", "OpenAI Corp" — capitalized chunk followed by
        // an org suffix. Walk back a bit to capture multi-word org
        // names like "Sci Cognitive Inc".
        if i + 1 < toks.len() {
            let next_norm = toks[i + 1].norm.trim_end_matches('.');
            if ORG_SUFFIXES.contains(next_norm) {
                let span = surface_span(text, t.surface, &toks[i + 1]);
                push(&mut out, &mut seen, span, EntityType::Org);
                i += 2;
                continue;
            }
        }

        i += 1;
    }

    out
}

/// Compute the substring of `text` spanning from `start_surface`'s
/// beginning to `end_token.surface`'s end. We do this by finding both
/// in the original text — preserves casing + punctuation between
/// (e.g. "Casey Zandbergen" stays as the original two-word string).
///
/// Falls back to `start_surface + " " + end_surface` if locating
/// either fails — matches the user's intent even if the slicing fails.
fn surface_span(text: &str, start_surface: &str, end_token: &Token<'_>) -> String {
    if let Some(start_idx) = text.find(start_surface)
        && let Some(end_offset) = text[start_idx..].find(end_token.surface)
    {
        let end_idx = start_idx + end_offset + end_token.surface.len();
        return text[start_idx..end_idx].to_string();
    }
    format!("{} {}", start_surface, end_token.surface)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn entities_of_kind(text: &str, ty: EntityType) -> Vec<String> {
        extract_nlp_entities(text)
            .into_iter()
            .filter(|e| e.entity_type == ty)
            .map(|e| e.text)
            .collect()
    }

    #[test]
    fn first_name_alone() {
        let out = entities_of_kind("Casey said hello", EntityType::Person);
        assert_eq!(out, vec!["Casey"]);
    }

    #[test]
    fn first_name_compound() {
        let out = entities_of_kind("Casey Zandbergen ships sci", EntityType::Person);
        assert_eq!(out, vec!["Casey Zandbergen"]);
    }

    #[test]
    fn honorific_compound() {
        let out = entities_of_kind("Met with Dr. Smith yesterday", EntityType::Person);
        // "Dr." doesn't extend further because "yesterday" is lowercase.
        assert_eq!(out, vec!["Smith"]);
    }

    #[test]
    fn place_unigram() {
        let out = entities_of_kind("Visiting Tulsa next week", EntityType::Place);
        assert_eq!(out, vec!["Tulsa"]);
    }

    #[test]
    fn place_bigram() {
        let out = entities_of_kind("Flying to New York tomorrow", EntityType::Place);
        assert_eq!(out, vec!["New York"]);
    }

    #[test]
    fn place_with_state() {
        let out = entities_of_kind("Live in Tulsa, OK these days", EntityType::Place);
        assert!(out.contains(&"Tulsa".to_string()));
        assert!(out.contains(&"OK".to_string()));
    }

    #[test]
    fn org_suffix() {
        let out = entities_of_kind("Anthropic Inc shipped Claude", EntityType::Org);
        assert_eq!(out, vec!["Anthropic Inc"]);
    }

    #[test]
    fn allowlist_blocks_known_brand() {
        // `Apple` is allowlisted as a known brand. Even though "Apple"
        // appears in the place list... wait, it doesn't. Use a real
        // overlap: `Casey` would be a person name, but if we somehow
        // allowlisted it (we don't, just for this test), it'd be filtered.
        // Instead use Slack — allowlisted, never appear as PERSON/etc.
        let out = extract_nlp_entities("We use Slack at work");
        assert!(
            out.iter().all(|e| e.text != "Slack"),
            "Slack is allowlisted: should not be tagged as ORG/PERSON",
        );
    }

    #[test]
    fn realistic_session_prompt_catches_person() {
        // The prompt that motivated SCI-123. Before this ticket the
        // pipeline only caught sci.com via the bare-domain regex; now
        // it also catches "Casey Zandbergen" as PERSON.
        let prompt = "Hi! My name is Casey Zandbergen and I work on Sci, \
                      a sovereign cognitive identity layer at sci.com.";
        let out = extract_nlp_entities(prompt);
        let people: Vec<_> = out
            .iter()
            .filter(|e| e.entity_type == EntityType::Person)
            .map(|e| e.text.as_str())
            .collect();
        assert!(
            people.contains(&"Casey Zandbergen"),
            "expected Casey Zandbergen in {:?}", people,
        );
    }

    #[test]
    fn allowlisted_first_word_doesnt_extend() {
        // "Apple Vision" — "Apple" is allowlisted; the second word
        // "Vision" is capitalized but it's not a name. Expect no
        // PERSON match.
        let out = entities_of_kind("Apple Vision Pro launches today", EntityType::Person);
        assert!(out.is_empty(), "got: {:?}", out);
    }

    #[test]
    fn does_not_double_count_compound() {
        // A compound name should produce one Entity, not two (one for
        // the full + one for the first half).
        let out = extract_nlp_entities("Casey Zandbergen and Casey worked together");
        let casey_entries: Vec<_> = out
            .iter()
            .filter(|e| e.text.starts_with("Casey"))
            .collect();
        // "Casey Zandbergen" once + plain "Casey" once = 2 distinct entries.
        assert_eq!(casey_entries.len(), 2, "got: {:?}", casey_entries);
    }
}
