//! SCI-195 regression: deanonymize must refuse to substitute reverse-map
//! entries whose `original` value itself contains placeholder-shaped
//! text. Those rows are the historical poison from the pre-SCI-194 era,
//! where a buggy anonymizer wrote the placeholder back into the entity
//! string. Substituting them lands literal `[TYPE_N]` syntax in the
//! deanonymized output, which (a) leaks placeholder shape into the
//! user-visible response, and (b) feeds the model its own corrupted
//! vocabulary on the next turn.
//!
//! The defense is in `token_map::deanonymize`: a token whose mapped
//! `original` matches `\[[A-Z]+_\d+\]?` is skipped + tracing::warn!'d.
//! Deletion of the historical poisoned rows from sci.db
//! (`token_mappings`) is the cleanup; this code change is the wall that
//! stops new poison from being able to surface even if it returns.
//!
//! Placeholder literals are concat-built so this test source can't be
//! self-rewritten by an in-process anonymize pass, matching the
//! convention in sci197_placeholder_leak.rs.

use sci_anonymizer::{deanonymize, TokenMap};

/// Helper: the canonical placeholder shape we're defending against.
fn tok(prefix: &str, n: u32) -> String {
    String::from("[") + prefix + "_" + &n.to_string() + "]"
}

/// A reverse-map entry whose `original` *is* a placeholder must be
/// skipped — the deanonymizer must not substitute, the token must
/// survive verbatim in the output.
#[test]
fn poisoned_self_referential_original_is_skipped() {
    let mut map = TokenMap::new();
    let token  = tok("PERSON", 1);
    // The poison: `original` looks exactly like another placeholder.
    let poisoned_original = tok("PLACE", 2);
    map.reverse.insert(token.clone(), poisoned_original.clone());

    let input    = format!("hello {token} world");
    let restored = deanonymize(&input, &map);

    assert_eq!(
        restored, input,
        "poisoned self-referential entry must not be substituted; \
         expected the token to survive unchanged but got: {restored:?}",
    );
    assert!(
        !restored.contains(&poisoned_original),
        "poisoned original must NOT land in deanonymized output: {restored:?}",
    );
}

/// A reverse-map entry whose `original` is a normal string CONTAINING a
/// placeholder substring (e.g. `"Casey [PLACE_2]"`) is the shape of the
/// rows that were deleted from sci.db. Same defense: skip.
#[test]
fn poisoned_embedded_placeholder_in_original_is_skipped() {
    let mut map = TokenMap::new();
    let token = tok("PERSON", 6);
    // Mirrors the actual poison observed in sci.db.token_mappings:
    //   id=15022 | [PERSON_6] | "Casey" [PLACE_2"
    let poisoned_original = String::from("\"Casey\" ") + &tok("PLACE", 2);
    map.reverse.insert(token.clone(), poisoned_original.clone());

    let input    = format!("> {token} said: ok");
    let restored = deanonymize(&input, &map);

    assert!(
        restored.contains(&token),
        "poisoned token must survive verbatim; got: {restored:?}",
    );
    assert!(
        !restored.contains(&tok("PLACE", 2)),
        "embedded placeholder from poisoned original must not leak into \
         output: {restored:?}",
    );
}

/// Mixed map: one poisoned entry + one healthy entry. The poison is
/// skipped; the healthy substitution still happens. This is the live
/// invariant — the defense must not break clean mappings.
#[test]
fn poison_skip_does_not_break_healthy_entries() {
    let mut map = TokenMap::new();
    let healthy_token = tok("PERSON", 1);
    let poison_token  = tok("PERSON", 2);

    map.reverse.insert(healthy_token.clone(), "Casey".to_string());
    map.reverse.insert(poison_token.clone(),  tok("PLACE", 3));

    let input = format!(
        "{healthy_token} pinged {poison_token} earlier",
    );
    let restored = deanonymize(&input, &map);

    assert!(
        restored.starts_with("Casey "),
        "healthy entry must still substitute: {restored:?}",
    );
    assert!(
        restored.contains(&poison_token),
        "poisoned token must survive in same pass: {restored:?}",
    );
    assert!(
        !restored.contains(&tok("PLACE", 3)),
        "poisoned original must not leak: {restored:?}",
    );
}

/// Off-by-one defense: the regex also matches an `original` that opens
/// with a placeholder but has trailing chars (the `]?` makes the closing
/// bracket optional, mirroring real corruption that lost the `]`).
#[test]
fn poisoned_original_without_closing_bracket_is_skipped() {
    let mut map = TokenMap::new();
    let token = tok("PERSON", 4);
    // Real shape from poisoned row id=15020: `"Casey" [PLACE_2"` —
    // open bracket + TYPE_N but no closing bracket, then a quote.
    let truncated = String::from("\"Casey\" [PLACE_2\"");
    map.reverse.insert(token.clone(), truncated.clone());

    let input    = format!("from {token}: noted");
    let restored = deanonymize(&input, &map);

    assert!(
        restored.contains(&token),
        "token must survive even when poison is bracket-truncated: \
         {restored:?}",
    );
    assert!(
        !restored.contains("[PLACE_2"),
        "truncated placeholder must not leak: {restored:?}",
    );
}

/// Sanity guard: a perfectly clean mapping still gets substituted. If
/// the poison regex were overzealous (e.g. matching plain `Casey`), this
/// would fail and route the breaker straight here.
#[test]
fn clean_mapping_still_substitutes() {
    let mut map = TokenMap::new();
    let token = tok("PERSON", 1);
    map.reverse.insert(token.clone(), "Casey Zandbergen".to_string());

    let input    = format!("{token} replied");
    let restored = deanonymize(&input, &map);

    assert_eq!(restored, "Casey Zandbergen replied");
}
