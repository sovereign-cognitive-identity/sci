# Benchmark Corpus Manifest

This directory contains a labeled PII corpus for benchmarking sci-anonymizer against Presidio.

## Structure

```
corpus/
├── MANIFEST.md                    # This file
├── public/                        # Public PII datasets with source/license
│   ├── conll2003-persons.txt      # CoNLL-2003 NER (PERSON entities)
│   └── README.md                  # Source + license info
├── edge-cases/                    # SCI-195/196/197 regression test corpus
│   ├── sci195_poisoned_original.txt
│   ├── sci196_compound_bleed.txt
│   ├── sci197_placeholder_leak.txt
│   └── README.md
└── corpus-index.jsonl             # Line-delimited JSON: entity spans with types
```

## Corpus Index Format

Each line in `corpus-index.jsonl` is a JSON object:

```json
{
  "doc_id": "public:conll2003-persons:001",
  "text": "The quick brown fox jumps over the lazy dog.",
  "entities": [
    { "start": 4, "end": 9, "type": "PERSON", "text": "quick" },
    { "start": 25, "end": 28, "type": "PLACE", "text": "dog" }
  ]
}
```

### Entity Types

- **PERSON**: Names of individuals
- **ORG**: Organization names (companies, agencies, teams)
- **PLACE**: Geographic locations (cities, countries, landmarks)
- **EMAIL**: Email addresses
- **PHONE**: Phone numbers (all formats)
- **URL**: Web URLs and bare domains
- **HANDLE**: Social media handles (@username)

## Corpus Composition

### Public Datasets

**conll2003-persons** (CoNLL 2003 Named Entity Recognition)
- Source: https://huggingface.co/datasets/conll2003
- License: CC-BY-4.0
- Content: ~14k sentences with PERSON/ORG/PLACE/MISC annotations
- Usage: Core benchmark set (Presidio can evaluate against this)
- Size: ~5 MB

### Edge Case Corpus

These are drawn from the sci-anonymizer test suite and represent real bugs caught in production:

1. **SCI-195: Poisoned Original Skip** — deanonymize must refuse to substitute if `original` contains placeholder syntax
   - Test: `core/crates/sci-anonymizer/tests/sci195_poisoned_original_skip.rs`
   - Relevance: Detects if the anonymizer/deanonymizer can leak their own placeholder tokens

2. **SCI-196: Compound Bleed** — compound-extension rules must not absorb already-anonymized placeholders into new entity spans
   - Test: `core/crates/sci-anonymizer/tests/sci196_compound_bleed.rs`
   - Relevance: Detects re-anonymization/inference-loop bugs

3. **SCI-197: Placeholder Leak** — second-pass anonymization must not turn deanonymized output back into placeholders
   - Test: `core/crates/sci-anonymizer/tests/sci197_placeholder_leak.rs`
   - Relevance: Round-trip fidelity (anonymize → deanonymize → anonymize should be stable)

## Benchmark Metrics

For each document/entity, we measure:

- **Precision**: Of all entities sci-anonymizer detected, how many are true positives?
- **Recall**: Of all entities that should be detected, how many did sci-anonymizer find?
- **F1**: Harmonic mean of precision/recall

Per-entity-type breakdown shows which types (PERSON, EMAIL, etc.) have weak performance.

**Round-Trip Fidelity** (Sci only):
- Anonymize text → Deanonymize → Compare to original
- Score: 1.0 if identical, 0.0 if diverges
- Measures the reversibility guarantee

## Building the Index

Run:
```bash
cd benchmarks
python3 corpus-builder.py
```

This script:
1. Loads CoNLL2003 from HuggingFace (cached locally)
2. Extracts PERSON/ORG/PLACE entities and converts to our format
3. Merges edge-case documents from the test suite
4. Writes `corpus-index.jsonl`

## Running the Benchmark

See `benchmarks/run.sh` and `benchmarks/RESULTS.md`.
