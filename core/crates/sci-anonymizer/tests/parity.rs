//! TS↔Rust parity tests.
//!
//! Loads `core/tests/fixtures/anonymizer.json`, captured from the
//! TypeScript reference (see `capture-from-ts.mjs`). For each fixture:
//!
//!   1. Run Rust `anonymize` on the same input.
//!   2. Filter both expected (TS) and actual (Rust) entity sets
//!      through `is_allowlisted` — TS's NLP pass doesn't apply the
//!      allowlist (an oversight in the original implementation;
//!      Rust does). Comparing post-filter is the right semantics:
//!      "what entities did each side decide were worth masking."
//!   3. Assert set-equality on (text, type) pairs.
//!
//! Text-level comparison stays in the unit tests inside `token_map.rs`
//! — once the entity set matches, the rendered output is a function
//! of the (deterministic) `apply_token_map` logic, which is unit-
//! tested independently.
//!
//! Before SCI-123, this test filtered out PERSON / PLACE / ORG (the
//! NLP-only classes) since the Rust port had no NER. SCI-123 added a
//! lexicon + grammar NER, so the filter is gone — full parity now.

use sci_anonymizer::{Entity, EntityType, TECH_ALLOWLIST, anonymize};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize, Debug)]
struct Fixture {
    name:                  String,
    input:                 String,
    #[allow(dead_code)]
    expected_text:         String,
    #[allow(dead_code)]
    expected_entity_count: usize,
    expected_detected:     Vec<ExpectedEntity>,
}

#[derive(Deserialize, Debug)]
struct ExpectedEntity {
    text: String,
    #[serde(rename = "type")]
    entity_type: EntityType,
}

fn load_fixtures() -> Vec<Fixture> {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates/
    path.pop(); // workspace root
    path.push("tests");
    path.push("fixtures");
    path.push("anonymizer.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture JSON didn't parse")
}

fn key(text: &str, ty: EntityType) -> (String, EntityType) {
    (text.to_lowercase(), ty)
}

/// Case-insensitive allowlist lookup. The runtime `is_allowlisted` is
/// case-sensitive on purpose (so "SLACK" mid-sentence stays a possible
/// project name even though "Slack" is allowlisted); but TS's NLP pass
/// emits raw lowercase tokens like "twitter" that we still want to
/// drop in the parity comparison. Using a case-insensitive variant
/// here keeps both implementations comparable without weakening the
/// runtime check.
fn allowlisted_ci(text: &str) -> bool {
    let lower = text.to_lowercase();
    TECH_ALLOWLIST.iter().any(|w| w.to_lowercase() == lower)
}

#[test]
fn parity_full() {
    let fixtures = load_fixtures();
    assert!(!fixtures.is_empty(), "no fixtures loaded");

    let mut failures = Vec::new();

    for fx in &fixtures {
        let rust = anonymize(&fx.input, None);

        // Filter both sides through `is_allowlisted`. TS's NLP pass
        // doesn't honor the allowlist (a known TS-side gap); Rust's
        // does. Comparing apples-to-apples means dropping anything
        // either side allowlisted before set-equality.
        let expected: std::collections::BTreeSet<_> = fx
            .expected_detected
            .iter()
            .filter(|e| !allowlisted_ci(&e.text))
            .map(|e| key(&e.text, e.entity_type))
            .collect();

        let actual: std::collections::BTreeSet<_> = rust
            .detected
            .iter()
            .filter(|e: &&Entity| !allowlisted_ci(&e.text))
            .map(|e: &Entity| key(&e.text, e.entity_type))
            .collect();

        if expected != actual {
            failures.push(format!(
                "[{name}]\n  input    = {input:?}\n  expected = {expected:?}\n  actual   = {actual:?}",
                name = fx.name,
                input = fx.input,
                expected = expected,
                actual = actual,
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "parity diff:\n\n{}",
        failures.join("\n\n"),
    );
}
