# Presidio Comparison (Optional)

This directory contains an **optional** runner for comparing sci-anonymizer against Presidio.

## Why Optional?

Presidio has heavy dependencies (spaCy NLP models, protobuf, ML inference). To avoid:
- Pip conflicts with the main Sci environment
- Accidental installation in containers/CI
- Port binding issues

We keep Presidio **completely separate**.

## Setup (Manual)

If you want to benchmark against Presidio:

```bash
# 1. Create a virtual environment (optional but recommended)
python3 -m venv .venv-presidio
source .venv-presidio/bin/activate

# 2. Install Presidio
pip install presidio-analyzer presidio-anonymizer -q

# 3. Download spaCy model (one-time)
python3 -m spacy download en_core_web_sm

# 4. Run the comparison
python3 runner.py --corpus ../corpus/corpus-index.jsonl

# Results saved to results.json
```

## What It Does

`runner.py` performs the **exact same evaluation** as the main harness:
- Loads the corpus index
- Runs Presidio analyzer on each text
- Measures precision/recall per entity type
- Outputs `results.json`

The main benchmark report (`../RESULTS.md`) will **automatically include** Presidio metrics if `results.json` exists.

## Key Differences: Sci vs Presidio

| Aspect | Sci | Presidio |
|--------|-----|---------|
| **Reversible** | ✓ Anonymize → Deanonymize | ✗ Destructive one-way |
| **Token map** | ✓ Tracks entity→placeholder mapping | ✗ Redaction only |
| **Round-trip fidelity** | ✓ measurable | ✗ Not applicable |
| **NER approach** | Lexicon + regex + custom DB | ML models (spaCy, transformers) |
| **Dependencies** | Minimal (no ML models) | Heavy (spaCy + models) |

**Sci** is optimized for **reversible round-trip** (talk to Claude, get real answers).  
**Presidio** is optimized for **secure redaction** (logs, compliance).

Not competitors; different use cases.

## Troubleshooting

### spaCy model fails to load
```
OSError: [E050] Can't find model "en_core_web_sm"
```

Solution:
```bash
python3 -m spacy download en_core_web_sm
```

### ImportError: No module named presidio_analyzer
```
ModuleNotFoundError: No module named 'presidio_analyzer'
```

Solution:
```bash
pip install presidio-analyzer presidio-anonymizer
```

### Memory/Performance Issues

Presidio loads large spaCy models in memory. If running on a resource-constrained machine:
- Use the smaller spaCy model: `python3 -m spacy download en_core_web_sm` (already small)
- Reduce corpus size: modify `corpus-builder.py` to load fewer CoNLL examples

## Skipping Presidio

If you don't want to run Presidio, just skip this step. The main harness will work fine without it:

```bash
cd benchmarks && bash run.sh
# Generates RESULTS.md with sci-anonymizer metrics only
```

The benchmark is **meaningful without Presidio**. Inclusion is optional for deeper comparison.
