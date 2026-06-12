//! Round-trip fidelity benchmark — the metric Sci can report that one-way
//! redactors (Presidio, LLM Guard, gateway guardrails) structurally cannot.
//!
//! For each labeled input we measure two things:
//!
//!   1. **Masking recall** — of the entities that SHOULD be masked, how many
//!      no longer appear verbatim in the anonymized text. (Did we hide it?)
//!   2. **Round-trip fidelity** — does `deanonymize(anonymize(x))` reproduce
//!      the original input exactly? (Can we put it back?)
//!
//! Round-trip fidelity is the differentiator: a destructive redactor scores 0
//! here by construction, because it throws the original entities away.
//!
//! Run with:  cargo run -p sci-anonymizer --example roundtrip_fidelity
//!
//! This is deliberately honest: the corpus includes bare PERSON / ORG cases
//! that the lexicon NER (SCI-123) is known to miss, so masking recall will be
//! below 100%. Hiding that would defeat the point of a credibility benchmark.

use sci_anonymizer::{anonymize, deanonymize};

/// (input, substrings that should be masked out of the anonymized text)
const CORPUS: &[(&str, &[&str])] = &[
    ("email me at casey@sci.com", &["casey@sci.com"]),
    ("visit https://dancingbits.ai/about today", &["https://dancingbits.ai/about"]),
    ("call 415-555-0199 after noon", &["415-555-0199"]),
    ("ping me @caseyz on the bird site", &["@caseyz"]),
    ("the box is at 195.26.249.211", &["195.26.249.211"]),
    ("OpenClaw runs nightly on the server", &["OpenClaw"]),
    ("BlueBubbles bridges iMessage", &["BlueBubbles"]),
    ("token sk-abc123def456ghi789jkl012mno345pqr is live", &["sk-abc123def456ghi789jkl012mno345pqr"]),
    ("mail bob@example.com and see https://example.com", &["bob@example.com", "https://example.com"]),
    // Honest hard cases: bare PERSON / ORG names rely on lexicon NER (SCI-123),
    // which is incomplete. Expect these to drag masking recall down.
    ("Casey Zandbergen joined the call", &["Casey Zandbergen"]),
    ("she works at Northwind Logistics", &["Northwind Logistics"]),
];

fn main() {
    let mut expected_total = 0usize;
    let mut masked_ok = 0usize;
    let mut roundtrip_ok = 0usize;

    println!("# sci-anonymizer round-trip fidelity\n");
    println!("| input | masked | round-trip |");
    println!("|---|---|---|");

    for (input, expected) in CORPUS {
        let result = anonymize(input, None);
        let restored = deanonymize(&result.text, &result.token_map);

        let this_masked = expected
            .iter()
            .filter(|e| !result.text.contains(**e))
            .count();
        expected_total += expected.len();
        masked_ok += this_masked;

        let rt = restored == *input;
        if rt {
            roundtrip_ok += 1;
        }

        let masked_cell = format!("{this_masked}/{}", expected.len());
        let rt_cell = if rt { "ok" } else { "FAIL" };
        let shown: String = input.chars().take(42).collect();
        println!("| {shown} | {masked_cell} | {rt_cell} |");
    }

    let n = CORPUS.len();
    let masking_recall = 100.0 * masked_ok as f64 / expected_total as f64;
    let rt_fidelity = 100.0 * roundtrip_ok as f64 / n as f64;

    println!("\n## Summary\n");
    println!("- Masking recall:     {masked_ok}/{expected_total}  ({masking_recall:.1}%)");
    println!("- Round-trip fidelity: {roundtrip_ok}/{n}  ({rt_fidelity:.1}%)");
    println!(
        "\nNote: masking recall below 100% is expected and honest — bare PERSON/ORG\n\
         detection depends on the lexicon NER tracked in SCI-123. Round-trip fidelity\n\
         is the capability one-way redactors cannot offer at all."
    );
}
