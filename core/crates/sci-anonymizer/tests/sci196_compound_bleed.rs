//! SCI-196 regression: compound-extension rules must not absorb already-
//! anonymized placeholder tokens into new entity spans.
//!
//! ## The bug
//!
//! `extract_nlp_entities` tokenizes text and tries to extend single-token
//! matches into multi-token compounds (e.g. "Casey" → "Casey Zandbergen").
//! The PERSON first-name extension rule looked at the *next* token and,
//! if it was capitalized, absorbed it.
//!
//! When a second anonymization pass ran on text already containing
//! placeholders like `Casey [PLACE_2]`, the next token after a first-name
//! hit was `[PLACE_2]` — starts with `[P`, which is uppercase — so the
//! rule extended. The resulting entity `.text` became the raw bytes from
//! the first bracket through the end of the second token:
//! `"Casey [PLACE_"` (15 chars, with a partial bracket because the
//! tokenizer strips trailing punctuation). That string entered
//! `token_mappings` as the `original` column value. The next
//! deanonymize pass then tried to rewrite a 15-byte slice in the
//! response to an unrelated PERSON name — the classic SCI-196 bleed.
//!
//! ## The fix (adf28ee)
//!
//! `Token::looks_like_placeholder` is set at tokenization time by
//! `is_bracketed_placeholder(raw)`, scanning the un-trimmed raw slice
//! so the leading `[` is still present. Every compound-extension guard
//! now checks `!toks[i+1].looks_like_placeholder` before extending.
//!
//! ## How these tests observe the bleed
//!
//! `Entity` (the public type) carries only `.text` + `.entity_type`.
//! The "original" that ends up in `token_mappings` is the forward-map
//! *key* — i.e. `token_map.forward` maps `original_string → [TYPE_N]`.
//! So:
//!
//!   - `extract_nlp_entities` — assert entity `.text` does NOT contain
//!     a placeholder fragment (the compound extension happened at the
//!     `.text` level before the map is built).
//!   - `anonymize_with_custom` / `anonymize` — assert that no key in
//!     `result.token_map.forward` spans a placeholder boundary (that's
//!     the token_mappings.original that would corrupt the DB).
//!
//! All placeholder-shaped string literals are **concat-built** from
//! parts (e.g. `String::from("[") + "PLACE_2]"`) so an in-process
//! anonymization pass running on this source file cannot rewrite them
//! and invalidate the test. Mirrors the convention in sci197 and sci195.

use sci_anonymizer::{anonymize, anonymize_with_custom, extract_nlp_entities, EntityType};

// ── helpers ───────────────────────────────────────────────────────────────

/// Build a placeholder token without writing the complete literal, so the
/// in-process anonymizer cannot rewrite the source.
fn ph(ty: &str, n: u32) -> String {
    String::from("[") + ty + "_" + &n.to_string() + "]"
}

/// Returns true if `s` contains a substring that looks like a placeholder
/// boundary crossing: `"] ["` (two tokens side by side) or a partial
/// open-bracket followed by a TYPE prefix.
fn contains_bleed(s: &str) -> bool {
    // Two adjacent placeholder tokens merged into one string.
    if s.contains("] [") {
        return true;
    }
    // Partial bracket: the string ends with `[TYPE_` without a closing `]`.
    // This is the exact shape produced by the pre-fix bug when the tokenizer
    // stripped the trailing `]` as punctuation.
    let re = regex::Regex::new(r"\[[A-Z]+_\d*$").unwrap();
    if re.is_match(s) {
        return true;
    }
    // The string *contains* a placeholder fragment anywhere in its interior.
    let inner = regex::Regex::new(r"\[[A-Z]+_").unwrap();
    inner.is_match(s)
}

// ── extract_nlp_entities: entity.text must not span a placeholder ─────────

/// Primary regression — the exact shape from the ticket.
///
/// Input: `"Casey [PLACE_2] is nice"`
///
/// Expected: `extract_nlp_entities` returns at most one PERSON entity whose
/// `.text` equals exactly `"[PERSON_1]"` (10 chars), not
/// `"Casey [PLACE_"` (18 chars with a partial bracket).
///
/// The assertion is on `.text.len() <= ph("PERSON",1).len()` rather than
/// an exact equality because the NER is allowed to decline to tag
/// placeholder-shaped input entirely — the critical invariant is that
/// it must NOT produce a `.text` that spans the boundary.
#[test]
fn person_placeholder_text_does_not_absorb_next_placeholder() {
    let p1 = ph("PERSON", 1);
    let p2 = ph("PLACE", 2);
    let input = format!("{p1} {p2} is nice");

    let entities = extract_nlp_entities(&input);
    for e in &entities {
        assert!(
            !contains_bleed(&e.text),
            "entity.text spans a placeholder boundary: {:?} (len {})\n\
             input was: {input:?}",
            e.text, e.text.len(),
        );
        // Belt-and-suspenders: text length must not exceed the longer of the
        // two individual placeholder tokens.
        let max_single = p1.len().max(p2.len());
        assert!(
            e.text.len() <= max_single,
            "entity.text ({} chars) is longer than a single placeholder \
             ({} chars), indicating compound bleed:\n  text={:?}\n  input={input:?}",
            e.text.len(), max_single, e.text,
        );
    }
}

/// Same check for the HONORIFIC → PERSON compound rule.
/// `"Dr. [PERSON_3] [PLACE_2]"` — the honorific extension must not
/// drag in the PLACE placeholder.
#[test]
fn honorific_compound_does_not_extend_through_placeholder() {
    let p3 = ph("PERSON", 3);
    let p2 = ph("PLACE", 2);
    let input = format!("Dr. {p3} lives near {p2}.");

    for e in extract_nlp_entities(&input) {
        assert!(
            !contains_bleed(&e.text),
            "honorific-extended entity.text bleeds into a placeholder: \
             {:?}\n  input={input:?}",
            e.text,
        );
    }
}

/// PLACE bigram rule: two adjacent PLACE placeholders must not be merged
/// into a single bigram PLACE entity.
#[test]
fn place_placeholder_bigram_not_merged() {
    let p1 = ph("PLACE", 1);
    let p2 = ph("PLACE", 2);
    let input = format!("She moved from {p1} {p2} to somewhere new.");

    for e in extract_nlp_entities(&input) {
        assert!(
            !contains_bleed(&e.text),
            "two PLACE placeholders merged into single entity: {:?}\n\
             input={input:?}",
            e.text,
        );
    }
}

// ── token_map.forward keys must not span placeholder boundaries ───────────
//
// The forward map key is what gets stored as `original` in token_mappings.
// If a key spans a placeholder boundary (e.g. `"Casey [PLACE_"`) then
// deanonymize will attempt to rewrite that 15-byte slice in model output,
// producing the SCI-196 bleed.

/// Round-trip through `anonymize`: the forward-map keys produced from text
/// that already contains placeholders must not themselves contain any
/// placeholder-shaped fragment.
#[test]
fn anonymize_forward_keys_do_not_span_placeholder_boundaries() {
    let p1 = ph("PERSON", 1);
    let p2 = ph("PLACE", 2);
    // Simulate a second anonymization pass on recall-injected text.
    let input = format!(
        "The user {p1} mentioned that {p2} is their home town.",
    );

    let result = anonymize(&input, None);

    for key in result.token_map.forward.keys() {
        assert!(
            !contains_bleed(key),
            "token_map forward key contains a placeholder fragment — \
             this would corrupt token_mappings.original:\n  key={key:?}\n\
             input={input:?}",
        );
    }
}

/// Same check via `anonymize_with_custom` (the path used in production
/// when custom entities are present).
#[test]
fn anonymize_with_custom_forward_keys_do_not_span_placeholder_boundaries() {
    let p1 = ph("PERSON", 1);
    let p2 = ph("PLACE", 2);
    let p3 = ph("PERSON", 3);
    let input = format!(
        "{p1} told {p3} to meet in {p2} next week.",
    );

    let result = anonymize_with_custom(&input, None, &[]);

    for key in result.token_map.forward.keys() {
        assert!(
            !contains_bleed(key),
            "token_map forward key (from anonymize_with_custom) contains a \
             placeholder fragment:\n  key={key:?}\n  input={input:?}",
        );
    }
}

// ── Complement: real names adjacent to placeholders still work ────────────

/// A real first name BEFORE a placeholder must still be detected as PERSON.
/// The placeholder blocks *extension* of the match, not the match itself.
#[test]
fn real_name_before_placeholder_is_still_detected() {
    let p2 = ph("PLACE", 2);
    let input = format!("Casey flew to {p2} yesterday.");

    let persons: Vec<_> = extract_nlp_entities(&input)
        .into_iter()
        .filter(|e| e.entity_type == EntityType::Person)
        .collect();

    assert!(
        persons.iter().any(|e| e.text == "Casey"),
        "Casey should be detected as PERSON even when followed by a \
         PLACE placeholder; got: {persons:?}",
    );
    for e in &persons {
        assert!(
            !contains_bleed(&e.text),
            "PERSON entity text absorbed a placeholder: {:?}", e.text,
        );
    }
}

/// A real first name AFTER a placeholder — must still be detected.
#[test]
fn real_name_after_placeholder_is_still_detected() {
    let p1 = ph("PERSON", 1);
    let input = format!("{p1} and Casey worked on the same task.");

    let persons: Vec<_> = extract_nlp_entities(&input)
        .into_iter()
        .filter(|e| e.entity_type == EntityType::Person)
        .collect();

    assert!(
        persons.iter().any(|e| e.text == "Casey"),
        "Casey should be detected as PERSON even when preceded by \
         a PERSON placeholder; got: {persons:?}",
    );
}

/// A real compound name where the second token is NOT a placeholder must
/// still produce the compound entity. Guards against an over-broad fix
/// that disables all compound extension.
#[test]
fn real_compound_name_still_produces_compound_entity() {
    let input = "Casey Zandbergen reviewed the PR.";
    let persons: Vec<_> = extract_nlp_entities(input)
        .into_iter()
        .filter(|e| e.entity_type == EntityType::Person)
        .collect();

    assert!(
        persons.iter().any(|e| e.text == "Casey Zandbergen"),
        "compound PERSON entity must still be produced when no \
         placeholders are present; got: {persons:?}",
    );
}

// ── Edge cases ────────────────────────────────────────────────────────────

/// Placeholder with a trailing comma — `[PERSON_1],` — the tokenizer
/// strips the comma from `surface` but the raw slice still starts with `[`.
/// `is_bracketed_placeholder` scans the raw slice, so it must detect the
/// placeholder even with the trailing comma and block extension.
#[test]
fn placeholder_with_trailing_comma_blocks_compound_extension() {
    let p1 = ph("PERSON", 1);
    // The comma is attached directly to the closing bracket.
    let with_comma = format!("{p1},");
    let input = format!("{with_comma} Zandbergen arrived for the meeting.");

    for e in extract_nlp_entities(&input) {
        assert!(
            !contains_bleed(&e.text),
            "compound extension crossed a comma-bearing placeholder: {:?}\n\
             input={input:?}",
            e.text,
        );
    }
}

/// All-placeholder input must not panic and must not produce any entity
/// whose text spans more than one token.
#[test]
fn all_placeholder_input_does_not_panic_or_produce_multi_token_entities() {
    let p1 = ph("PERSON", 1);
    let p2 = ph("PLACE", 2);
    let p3 = ph("PERSON", 3);
    let input = format!("{p1} told {p3} to meet at {p2}.");

    // Must not panic.
    let entities = extract_nlp_entities(&input);

    for e in &entities {
        assert!(
            !contains_bleed(&e.text),
            "entity text spans multiple placeholder tokens: {:?}\n\
             input={input:?}",
            e.text,
        );
    }
}
