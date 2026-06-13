// benchmarks/src/lib.rs
// Rust harness for SCI-291 benchmark

use sci_anonymizer::{anonymize, deanonymize};
use serde_json::{json, Value};

/// Anonymize a single line of text and output JSON.
/// Input: plain text
/// Output: {"anonymized": "...", "entities": [...]}
pub fn anonymize_line(text: &str) -> Value {
    let result = anonymize(text, None);

    let entities = result
        .detected
        .iter()
        .map(|e| {
            json!({
                "text": e.text,
                "entity_type": e.entity_type.token_prefix(),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "anonymized": result.text,
        "entities": entities,
    })
}

/// Deanonymize a line of anonymized text.
/// Input: anonymized text + token_map
/// Output: {"deanonymized": "..."}
pub fn deanonymize_line(
    anonymized: &str,
    token_map: &sci_anonymizer::TokenMap,
) -> Value {
    let deanonymized = deanonymize(anonymized, token_map);
    json!({
        "deanonymized": deanonymized,
    })
}

/// Measure round-trip fidelity: anonymize → deanonymize → compare to original.
pub fn measure_round_trip(text: &str) -> Value {
    let result = anonymize(text, None);
    let deanonymized = deanonymize(&result.text, &result.token_map);

    let fidelity = if text == deanonymized { 1.0 } else { 0.0 };

    json!({
        "original": text,
        "anonymized": result.text,
        "deanonymized": deanonymized,
        "fidelity": fidelity,
        "entities": result.detected
            .iter()
            .map(|e| json!({
                "text": e.text,
                "entity_type": e.entity_type.token_prefix(),
            }))
            .collect::<Vec<_>>(),
    })
}
