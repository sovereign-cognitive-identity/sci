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
            let mut end_idx = j;
            while end_idx < toks.len()
                && end_idx < j + 3
                && toks[end_idx].is_cap
            {
                end_idx += 1;
            }
            let span = surface_span(text, &toks[j], &toks[end_idx - 1]);
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
                    let span = surface_span(text, t, &toks[i + 1]);
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
                let span = surface_span(text, t, &toks[i + 1]);
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
                let span = surface_span(text, t, &toks[i + 1]);
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
/// Byte offset of `slice` within its parent `text`, or `None` if
/// `slice` is not actually a sub-slice of `text`'s allocation.
///
/// Casting `&str::as_ptr()` to `usize` is SAFE — no `unsafe` block
/// needed because we never dereference the raw pointer; we just
/// compare addresses as integers. The result is only meaningful when
/// `slice` was produced by an operation that returns a sub-slice of
/// `text` (e.g. `text.split_whitespace()`, `&text[a..b]`). The
/// bounds check below catches the case where the slice came from a
/// different allocation entirely.
fn offset_in(text: &str, slice: &str) -> Option<usize> {
    let text_start  = text.as_ptr() as usize;
    let text_end    = text_start + text.len();
    let slice_start = slice.as_ptr() as usize;
    let slice_end   = slice_start + slice.len();
    (slice_start >= text_start && slice_end <= text_end)
        .then_some(slice_start - text_start)
}

/// Capture the slice of `text` spanning from `start_token` through
/// `end_token`, trimmed of surrounding punctuation.
///
/// SCI-194 fix: previously this used `text.find(start.surface)`, which
/// returns the FIRST occurrence in the entire text. When the same
/// surface appeared multiple times (e.g. "Casey" early + "Casey
/// Zandbergen" later in the same input), the function paired the
/// earlier "Casey" with the later capitalized token and slurped
/// everything between them into the entity's `original`. That
/// polluted `token_mappings.original` with multi-sentence chunks that
/// included bracketed tokens from prior anonymization passes,
/// producing cascading nested-token garbage in model output.
///
/// `Token::raw` is always a sub-slice of the input `text` (built by
/// `tokenize` via `text.split_whitespace()`), so pointer arithmetic
/// gives the true byte position of each token without ambiguity.
fn surface_span(text: &str, start_token: &Token<'_>, end_token: &Token<'_>) -> String {
    let (Some(s), Some(e_start)) =
        (offset_in(text, start_token.raw), offset_in(text, end_token.raw))
    else {
        // Tokens not from this `text` — should be impossible for
        // in-crate callers (all four call sites pass tokens from the
        // same `toks` vector built by `tokenize(text)`), but synthesize
        // defensively rather than return a wrong-span string.
        return format!("{} {}", start_token.surface, end_token.surface);
    };
    let e = e_start + end_token.raw.len();
    debug_assert!(
        s <= e && e <= text.len(),
        "surface_span: range [{s}..{e}] escapes text (len {})",
        text.len(),
    );
    // Promote the debug-assert to a release-safe fallback so we never
    // panic in production on a corrupted Token.
    if s > e || e > text.len() {
        return format!("{} {}", start_token.surface, end_token.surface);
    }
    text[s..e]
        .trim_matches(|c: char| c.is_ascii_punctuation() && c != '\'' && c != '"')
        .to_string()
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

    // ── SCI-194 regression tests ──────────────────────────────────────────
    //
    // Pre-fix, `surface_span` used `text.find(start_surface)` which
    // returns the FIRST byte offset of the surface in the full input.
    // Repeated surfaces would alias to an earlier occurrence and the
    // returned span would cover everything between that earlier hit
    // and the current end-token — producing multi-sentence "originals"
    // that polluted the token_mappings table.

    #[test]
    fn repeated_surface_does_not_grab_intervening_text() {
        // "Casey" appears early; compound rule fires on the LATER
        // "Casey Zandbergen". The bug paired the early Casey with the
        // late Zandbergen and captured everything between.
        let text = "Hey Casey, before we discussed that, \
                    we talked about Casey Zandbergen yesterday.";
        let persons: Vec<String> = extract_nlp_entities(text)
            .into_iter()
            .filter(|e| e.entity_type == EntityType::Person)
            .map(|e| e.text)
            .collect();
        assert!(
            persons.contains(&"Casey".to_string()),
            "missing standalone Casey; got {persons:?}",
        );
        assert!(
            persons.contains(&"Casey Zandbergen".to_string()),
            "missing compound Casey Zandbergen; got {persons:?}",
        );
        for p in &persons {
            assert!(
                !p.contains("discussed") && !p.contains("before") && !p.contains(","),
                "entity text grabbed intervening prose: {p:?}",
            );
        }
    }

    #[test]
    fn triple_repeat_surface_stays_local() {
        // Three "Casey"s across three sentences. None of the entity
        // texts should span sentence boundaries.
        let text = "Casey said hi. Then Casey said goodbye. \
                    Finally Casey Zandbergen arrived.";
        for e in extract_nlp_entities(text) {
            assert!(
                !e.text.contains('.'),
                "entity text spans a sentence boundary: {:?}", e.text,
            );
            assert!(
                e.text.len() <= 30,
                "entity text suspiciously long: {:?} ({} chars)",
                e.text, e.text.len(),
            );
        }
    }

    #[test]
    fn bracketed_tokens_not_absorbed_into_entity_text() {
        // Mimics text from recall injection: prior anonymization
        // produced `[PLACE_2]` embedded in the prose. The new pass
        // should NOT slurp the bracketed token into the original of a
        // new entity span.
        let text = "Casey moved to [PLACE_2] and then Casey Zandbergen followed.";
        for e in extract_nlp_entities(text) {
            assert!(
                !e.text.contains("[PLACE_") && !e.text.contains("[PERSON_"),
                "entity text absorbed a bracketed token: {:?}", e.text,
            );
        }
    }

    #[test]
    fn org_repeated_surface_stays_local() {
        // Same bug class applied to the ORG-suffix rule. "Anthropic"
        // appears twice. The compound match should stay local to the
        // second occurrence + "Inc".
        let text = "Anthropic is great. Later, Anthropic Inc shipped Claude.";
        let orgs: Vec<String> = extract_nlp_entities(text)
            .into_iter()
            .filter(|e| e.entity_type == EntityType::Org)
            .map(|e| e.text)
            .collect();
        assert!(
            orgs.contains(&"Anthropic Inc".to_string()),
            "missing Anthropic Inc; got {orgs:?}",
        );
        for o in &orgs {
            assert!(
                !o.contains("great") && !o.contains("Later"),
                "ORG text grabbed intervening prose: {o:?}",
            );
        }
    }
}
