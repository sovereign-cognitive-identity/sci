// benchmarks/src/lib.rs
// Rust harness for SCI-291 benchmark

use sci_anonymizer::{anonymize, deanonymize, AnonymizeResult};
use serde_json::{json, Value};
use std::io::{self, BufRead};

/// Anonymize a single line of text and output JSON.
/// Input: plain text
/// Output: {"anonymized": "...", "entities": [...]}
pub fn anonymize_line(text: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let result = anonymize(text)?;

    let entities = result
        .entities
        .iter()
        .map(|e| {
            json!({
                "text": e.text,
                "entity_type": e.entity_type.to_string(),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "anonymized": result.anonymized_text,
        "entities": entities,
    }))
}

/// Deanonymize a line of anonymized text.
/// Input: {"anonymized": "...", "token_map": {...}}
/// Output: {"deanonymized": "..."}
pub fn deanonymize_line(
    anonymized: &str,
    token_map: &sci_anonymizer::TokenMap,
) -> Result<Value, Box<dyn std::error::Error>> {
    let deanonymized = deanonymize(anonymized, token_map);
    Ok(json!({
        "deanonymized": deanonymized,
    }))
}

/// Measure round-trip fidelity: anonymize → deanonymize → compare to original.
pub fn measure_round_trip(text: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let result = anonymize(text)?;
    let deanonymized = deanonymize(&result.anonymized_text, &result.token_map);

    let fidelity = if text == deanonymized { 1.0 } else { 0.0 };

    Ok(json!({
        "original": text,
        "anonymized": result.anonymized_text,
        "deanonymized": deanonymized,
        "fidelity": fidelity,
        "entities": result.entities
            .iter()
            .map(|e| json!({
                "text": e.text,
                "entity_type": e.entity_type.to_string(),
            }))
            .collect::<Vec<_>>(),
    }))
}
