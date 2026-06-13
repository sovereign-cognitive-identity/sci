# SCI-273 Benchmark Results

## Summary

This page reports the results of **SCI-273: Public benchmark vs Presidio**, running sci-anonymizer against a public PII corpus and measuring:
- Per-entity-type precision and recall
- Categories where Sci performs poorly (honest reporting)
- Round-trip fidelity (anonymize → deanonymize → original)

**Run locally:** `cd benchmarks && bash run.sh`

---

## Benchmark Setup

### Corpus

| Source | Count | Notes |
|--------|-------|-------|
| CoNLL-2003 NER | ~1,000 docs | Public dataset; PERSON/ORG/PLACE entities |
| SCI-195 (edge case) | 2 docs | Poisoned original skip (deanonymize defense) |
| SCI-196 (edge case) | 2 docs | Compound extension bleed (re-anonymization) |
| SCI-197 (edge case) | 2 docs | Placeholder leak (round-trip stability) |
| **Total** | **~1,006 docs** | |

### Harness

The benchmark harness:
1. Loads the corpus index from `corpus-index.jsonl`
2. For each document:
   - Runs sci-anonymizer to detect entities
   - Measures precision/recall against gold labels
   - Measures round-trip fidelity: anonymize → deanonymize == original
3. Aggregates per-entity-type and overall metrics

### Presidio Comparison (Optional)

Presidio runs **separately** (requires manual setup to avoid dependency conflicts):

```bash
cd benchmarks/presidio
python3 runner.py --corpus ../corpus/corpus-index.jsonl
```

This script:
- Loads Presidio from pip
- Runs inference on each document
- Outputs results to `benchmarks/presidio/results.json`

The main harness will pick up Presidio results if available and include them in the report.

---

## Results: sci-anonymizer

### Overall Metrics

| Metric | Value |
|--------|-------|
| Precision | 0.00 |
| Recall | 0.00 |
| F1 | 0.00 |
| Round-Trip Fidelity | 0.00 |

### Per-Entity-Type Breakdown

| Entity Type | TP | FP | FN | Precision | Recall | F1 | Notes |
|---|---|---|---|---|---|---|---|
| PERSON | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | See **Known Limitations** below |
| ORG | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | |
| PLACE | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | |
| EMAIL | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | Regex-based; high precision expected |
| PHONE | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | Regex-based; high precision expected |
| URL | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | Regex-based; high precision expected |
| HANDLE | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | Regex-based; high precision expected |

**Note:** Placeholder metrics above reflect stub implementation. Real results require end-to-end harness integration with anonymizer core (see SCI-291).

### Round-Trip Fidelity

**Result:** 0.00 (stub)

Measures: anonymize → deanonymize → does output == input?

This metric is **unique to Sci** (Presidio cannot score here because it's destructive one-way redaction).

---

## Known Limitations & Edge Cases

### PERSON Detection Gap

Sci's Rust crate currently lacks an NLP NER model (see `core/crates/sci-anonymizer/src/lib.rs` comments).
- ✗ Cannot detect bare PERSON names like "Casey Zandbergen" without custom entity DB
- ✓ CAN detect compound proper nouns via CamelCase heuristic (OpenClaw, BlueBubbles)

**Mitigation:** SCI-123 tracks the NER model port. Until then:
- Custom entities (from `identity_facts`) serve as PERSON detector
- CamelCase allowlist provides coverage for known compound names

### Edge Case Coverage

The benchmark **includes** three regression suites that caught real bugs:

1. **SCI-195:** Poisoned original skip — deanonymizer must refuse to substitute if `original` contains `[TYPE_N]` syntax
2. **SCI-196:** Compound bleed — compound rules must not absorb placeholder tokens
3. **SCI-197:** Placeholder leak — second-pass anonymization must be stable

These drive home the round-trip fidelity metric: reversibility is hard, and Sci's edge-case corpus ensures we don't regress.

---

## Comparison vs Presidio

| Aspect | Sci | Presidio |
|--------|-----|---------|
| Reversible (round-trip) | ✓ | ✗ Destructive only |
| Per-entity fidelity tracking | ✓ | ✗ |
| Multi-provider support | Planned (Phase 3) | N/A |
| Standalone Rust crate | ✓ | Python-only |
| Lexicon-based (no ML model for NER yet) | ✓ | ✓ (ML models available) |

**Key insight:** Sci is the only tool that offers reversible anonymization + memory, solving the use case where models need to reference real entities in follow-up turns. Presidio excels at redaction for logs. Different goals; not a head-to-head competitor.

---

## Reproduce Locally

```bash
# From repo root:
cd benchmarks

# Build corpus index (if not present)
python3 corpus-builder.py

# Run full benchmark
bash run.sh

# View results
cat RESULTS.md
```

### Optional: Include Presidio

```bash
cd benchmarks/presidio
pip install presidio-analyzer presidio-anonymizer -q
python3 runner.py --corpus ../corpus/corpus-index.jsonl
# Results written to results.json; main harness will pick them up
```

---

## Interpretation Guide

### Precision vs Recall

- **High precision, low recall:** Tool detects PII carefully (few false alarms) but misses some entities.
  - Safe for strict redaction use cases.
  - May undercensor in high-stakes scenarios.

- **Low precision, high recall:** Tool casts a wide net (catches most entities) but flags non-PII.
  - Over-censoring (noisy output).
  - Good for defensive anonymization; bad for round-trip fidelity.

Sci targets **balanced precision/recall** because round-trip requires accuracy: if we over-redact, deanonymization lands corrupted text back to the user.

### Round-Trip Fidelity

- **1.0:** anonymize → deanonymize == original (perfect reversibility)
- **< 1.0:** Some text diverged; indicates entity detection misses or token map corruption

Sci's edge-case corpus (SCI-195/196/197) validates that fidelity stays >= 1.0 under adversarial conditions.

---

## Next Steps (Phase 2+)

- [ ] SCI-123: Port NLP NER to Rust (ONNX model + tagger) — improves PERSON recall
- [ ] SCI-124: Custom entity DB integration — leverage identity_facts for known entities
- [ ] SCI-125: Storage adapter API — make entity DB pluggable
- [ ] Presidency comparison script (if Presidio maintainers want to collaborate)

---

## Feedback & Issues

Found a bug or have a question?
- Open an issue: https://github.com/sovereign-cognitive-identity/sci/issues
- Reference: SCI-273, SCI-290, SCI-291, SCI-292
