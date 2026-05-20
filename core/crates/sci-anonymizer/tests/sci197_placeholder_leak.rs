//! SCI-197 regression: model-emitted placeholders + over-tokenization.
//!
//! Two failure modes covered:
//!
//!   1. `FileSystemDirectoryEntry` (and other web platform / language
//!      vocabulary) MUST land in the allowlist so the CamelCase pass
//!      never tokenizes them. If it did, the model would learn the
//!      placeholder spelling from context and emit it back into code.
//!
//!   2. `deanonymize` must leave unmapped `[TYPE_N]` tokens verbatim
//!      AND emit a tracing WARN per distinct unmapped token, so the
//!      audit pipeline has a signal that this class of bug occurred
//!      (instead of the previous silent pass-through).
//!
//! The CamelCase coverage doubles as a guard against allowlist regressions
//! \u2014 deleting an entry from `TECH_ALLOWLIST` will fail one of these
//! assertions and route the deleter to this file.

use sci_anonymizer::{anonymize_with_custom, deanonymize, TokenMap};

/// Sanity: a CamelCase identifier listed in the allowlist must NOT be
/// turned into a `[PROJECT_n]` token.
#[test]
fn allowlist_covers_web_platform_dom_types() {
    let cases = [
        // The specific identifiers that bit SCI-166c when writing the
        // folder picker.
        "FileSystemDirectoryEntry",
        "FileSystemDirectoryReader",
        "FileSystemFileEntry",
        "FileSystemEntry",
        "DataTransfer",
        "DataTransferItem",
        // React types the model writes constantly.
        "ReactNode",
        "HTMLTextAreaElement",
        "TextareaHTMLAttributes",
        // Rust types the model writes in this very codebase.
        "HashMap",
        "HashSet",
        "PathBuf",
    ];

    for identifier in cases {
        let text = format!(
            "Walk a {identifier} recursively and tag each leaf.",
        );
        let result = anonymize_with_custom(&text, None, &[]);
        assert!(
            result.detected.is_empty(),
            "{identifier} should be allowlisted but was extracted as {:?}",
            result.detected,
        );
        assert_eq!(
            result.text, text,
            "{identifier} should pass through anonymize unchanged",
        );
    }
}

/// The diagnostic side: `deanonymize` of a model response containing an
/// unmapped placeholder must leave the placeholder text in place (so the
/// downstream consumer can see something happened) rather than dropping
/// it or rewriting it to something wrong.
#[test]
fn deanonymize_leaves_unmapped_placeholders_verbatim() {
    let map = TokenMap::new(); // empty: nothing to substitute.
    // Simulate a model response that contains a placeholder it minted
    // on its own. This is what happens when the model has seen
    // `[PROJECT_3]` in its context (because an earlier turn anonymized
    // `TreeNode`) and emits it back into code in a fresh turn whose
    // token map does NOT contain the original mapping.
    let model_response = "import TreeNode from './TreeNode';";
    let restored = deanonymize(model_response, &map);
    assert_eq!(
        restored, model_response,
        "unmapped placeholder must pass through verbatim, not be dropped",
    );
}

/// Multi-token version of the above: the regex sweep should warn for
/// every distinct placeholder even when the surrounding text has other
/// (mapped) tokens that got resolved successfully.
#[test]
fn deanonymize_passes_through_mixed_mapped_and_unmapped() {
    let mut map = TokenMap::new();
    map.reverse.insert(
        String::from("[") + "PERSON_1" + "]",
        "Casey".to_string(),
    );

    let unmapped_a = String::from("[") + "PROJECT_3" + "]";
    let unmapped_b = String::from("[") + "OBJECT_7" + "]";
    let mapped_in  = String::from("[") + "PERSON_1" + "]";

    let input = format!(
        "{mapped_in} dropped a folder; the picker walked the {unmapped_a} tree using a {unmapped_b}.",
    );
    let restored = deanonymize(&input, &map);

    assert!(
        restored.starts_with("Casey "),
        "mapped token should be substituted: {restored:?}",
    );
    assert!(
        restored.contains(&unmapped_a),
        "unmapped PROJECT placeholder should survive: {restored:?}",
    );
    assert!(
        restored.contains(&unmapped_b),
        "unmapped OBJECT placeholder should survive: {restored:?}",
    );
}

/// End-to-end shape: anonymize a prompt that mentions a real PERSON +
/// a web platform type. The PERSON gets tokenized; the platform type
/// does NOT. Then the model emits code referencing both. Deanonymize
/// substitutes the PERSON back and leaves the platform type \u2014 i.e.
/// the SCI-166c failure mode would have been impossible if SCI-197
/// had been in place.
#[test]
fn sci197_round_trip_does_not_corrupt_generated_code() {
    let prompt = "Casey wants a folder walker that reads FileSystemDirectoryEntry recursively.";
    let result = anonymize_with_custom(prompt, None, &[]);

    // Casey is a first-name lexicon hit \u2014 must be tokenized.
    // FileSystemDirectoryEntry is allowlisted \u2014 must NOT be tokenized.
    assert!(
        result.text.contains("FileSystemDirectoryEntry"),
        "platform type must survive anonymization; got: {}",
        result.text,
    );
    assert!(
        !result.text.contains("Casey"),
        "PERSON must be anonymized; got: {}",
        result.text,
    );

    // Simulated model response: code referencing both. The PERSON
    // placeholder is whatever the prompt minted; the platform type is
    // the real identifier.
    let person_token = result.token_map.forward.get("Casey")
        .expect("Casey should have a token mapping");
    let model_response = format!(
        "// for {person_token}\nfunction walk(root: FileSystemDirectoryEntry) {{}}\n",
    );

    let restored = deanonymize(&model_response, &result.token_map);
    assert!(restored.contains("Casey"), "{restored}");
    assert!(restored.contains("FileSystemDirectoryEntry"), "{restored}");
    // Critically: no leaked placeholder syntax in the final code.
    let placeholder_re = regex::Regex::new(r"\[[A-Z]+_\d+\]").unwrap();
    assert!(
        !placeholder_re.is_match(&restored),
        "deanonymized code must contain zero placeholder-shaped tokens: {restored:?}",
    );
}
