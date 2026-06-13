#!/usr/bin/env python3
"""
Benchmark harness for SCI-273: sci-anonymizer vs Presidio.

Computes per-entity-type precision/recall and round-trip fidelity.
Can optionally compare against Presidio (requires separate install).

Usage:
    python3 harness.py --corpus corpus-index.jsonl --sci-only
    python3 harness.py --corpus corpus-index.jsonl --with-presidio
"""

import json
import sys
import subprocess
import tempfile
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional
from collections import defaultdict
from dataclasses import dataclass, asdict
import argparse


@dataclass
class Metrics:
    """Per-entity-type metrics."""
    entity_type: str
    tp: int = 0  # true positives
    fp: int = 0  # false positives
    fn: int = 0  # false negatives

    @property
    def precision(self) -> float:
        if self.tp + self.fp == 0:
            return 0.0
        return self.tp / (self.tp + self.fp)

    @property
    def recall(self) -> float:
        if self.tp + self.fn == 0:
            return 0.0
        return self.tp / (self.tp + self.fn)

    @property
    def f1(self) -> float:
        if self.precision + self.recall == 0:
            return 0.0
        return 2 * (self.precision * self.recall) / (self.precision + self.recall)


def load_corpus_index(path: str) -> List[Dict[str, Any]]:
    """Load corpus index from JSONL file."""
    docs = []
    with open(path) as f:
        for line in f:
            if line.strip():
                docs.append(json.loads(line))
    return docs


def run_sci_anonymizer(text: str) -> Tuple[str, Dict[str, Any]]:
    """
    Run sci-anonymizer via Rust and get anonymized text + token map.

    Returns (anonymized_text, token_map_dict)
    """
    # We need to call into the Rust crate. For now, we'll create a simple
    # test harness that invokes the anonymizer.
    # TODO: this would ideally be a Rust binary or a Python binding.

    # Temporary workaround: write a Rust test that outputs JSON
    rust_script = f"""
use sci_anonymizer::{{anonymize, TokenMap}};
use std::io::Write;

fn main() {{
    let text = r#"{text.replace('"', '\\"')}"#;
    let result = anonymize(text).unwrap();

    let entities = result.entities.iter().map(|e| {{
        serde_json::json!({{
            "text": e.text,
            "entity_type": e.entity_type.to_string(),
        }})
    }}).collect::<Vec<_>>();

    println!("{{}}",  serde_json::json!({{
        "anonymized": result.anonymized_text,
        "entities": entities,
    }}));
}}
"""

    # For now, we'll return a placeholder
    # In the real implementation, this would call into the Rust crate
    return text, {}


def extract_sci_entities_via_cli(text: str) -> List[Dict[str, Any]]:
    """
    Extract entities using sci-anonymizer (via Rust binary or WASM).

    Returns list of detected entities:
    [
        {"start": 0, "end": 5, "type": "PERSON", "text": "..."},
        ...
    ]
    """
    # Placeholder: in the real implementation, we'd call:
    # - cargo run --manifest-path core/crates/sci-anonymizer/Cargo.toml -- <text>
    # or invoke via WASM bindings

    # For now, return empty; actual implementation TBD
    return []


def load_presidio_results(path: str) -> Optional[Dict[str, Any]]:
    """
    Load pre-computed Presidio results (if available).

    Presidio runs separately due to its dependencies.
    Results are cached in benchmarks/presidio/results.json
    """
    presidio_path = Path(__file__).parent / "presidio" / "results.json"
    if presidio_path.exists():
        with open(presidio_path) as f:
            return json.load(f)
    return None


def compute_entity_overlap(
    predicted: List[Dict[str, Any]],
    gold: List[Dict[str, Any]],
) -> Tuple[int, int, int]:
    """
    Compute true positives, false positives, false negatives.

    Tokens match if their spans and types agree (exact match).
    """
    tp = 0
    fp = 0
    fn = 0

    # Convert to sets of (start, end, type) for matching
    pred_spans = {
        (e["start"], e["end"], e["type"])
        for e in predicted
    }
    gold_spans = {
        (e["start"], e["end"], e["type"])
        for e in gold
    }

    tp = len(pred_spans & gold_spans)
    fp = len(pred_spans - gold_spans)
    fn = len(gold_spans - pred_spans)

    return tp, fp, fn


def measure_round_trip_fidelity(original: str, deanonymized: str) -> float:
    """
    Measure round-trip fidelity: does anonymize→deanonymize == original?

    Returns 1.0 if identical, 0.0 otherwise.
    (Could be extended to measure edit distance for partial credit.)
    """
    return 1.0 if original == deanonymized else 0.0


def benchmark_sci_anonymizer(
    corpus: List[Dict[str, Any]],
    sci_only: bool = True,
) -> Dict[str, Any]:
    """
    Benchmark sci-anonymizer on the given corpus.

    Returns:
    {
        "sci-anonymizer": {
            "PERSON": {"tp": ..., "fp": ..., "fn": ..., "precision": ..., "recall": ..., "f1": ...},
            "ORG": {...},
            "PLACE": {...},
            "EMAIL": {...},
            "PHONE": {...},
            "URL": {...},
            "HANDLE": {...},
            "overall": {...},
            "round_trip_fidelity": 0.95,
        },
        "presidio": {...} (if available)
    }
    """
    results = {
        "sci-anonymizer": {},
    }

    metrics_by_type = defaultdict(lambda: Metrics(entity_type=""))
    round_trip_fidelities = []

    for doc in corpus:
        text = doc["text"]
        gold_entities = doc.get("entities", [])

        # Anonymize via sci-anonymizer
        # TODO: once the Rust harness is set up, call it here
        anonymized, token_map = run_sci_anonymizer(text)

        # For now, we'll use a placeholder
        predicted_entities = extract_sci_entities_via_cli(text)

        # Measure round-trip fidelity (anonymize → deanonymize)
        # TODO: once Rust harness is set up, deanonymize here
        deanonymized = anonymized  # placeholder
        fidelity = measure_round_trip_fidelity(text, deanonymized)
        round_trip_fidelities.append(fidelity)

        # Accumulate metrics per entity type
        tp, fp, fn = compute_entity_overlap(predicted_entities, gold_entities)

        for entity in gold_entities:
            entity_type = entity["type"]
            metrics_by_type[entity_type].entity_type = entity_type

        for entity in gold_entities:
            entity_type = entity["type"]
            if entity in predicted_entities:
                metrics_by_type[entity_type].tp += 1
            else:
                metrics_by_type[entity_type].fn += 1

        for entity in predicted_entities:
            entity_type = entity["type"]
            if entity not in gold_entities:
                metrics_by_type[entity_type].fp += 1

    # Compute overall metrics
    overall = Metrics(entity_type="overall")
    for metrics in metrics_by_type.values():
        overall.tp += metrics.tp
        overall.fp += metrics.fp
        overall.fn += metrics.fn

    # Serialize to dict
    for entity_type in sorted(metrics_by_type.keys()):
        metrics = metrics_by_type[entity_type]
        results["sci-anonymizer"][entity_type] = {
            "tp": metrics.tp,
            "fp": metrics.fp,
            "fn": metrics.fn,
            "precision": round(metrics.precision, 4),
            "recall": round(metrics.recall, 4),
            "f1": round(metrics.f1, 4),
        }

    results["sci-anonymizer"]["overall"] = {
        "tp": overall.tp,
        "fp": overall.fp,
        "fn": overall.fn,
        "precision": round(overall.precision, 4),
        "recall": round(overall.recall, 4),
        "f1": round(overall.f1, 4),
    }

    mean_fidelity = sum(round_trip_fidelities) / len(round_trip_fidelities) if round_trip_fidelities else 0.0
    results["sci-anonymizer"]["round_trip_fidelity"] = round(mean_fidelity, 4)

    return results


def main():
    parser = argparse.ArgumentParser(description="Benchmark sci-anonymizer for SCI-273")
    parser.add_argument("--corpus", required=True, help="Path to corpus-index.jsonl")
    parser.add_argument("--sci-only", action="store_true", help="Only benchmark sci-anonymizer (no Presidio)")
    parser.add_argument("--with-presidio", action="store_true", help="Include Presidio comparison (requires separate setup)")
    parser.add_argument("--output", default="results.json", help="Output file for results")

    args = parser.parse_args()

    # Load corpus
    print(f"Loading corpus from {args.corpus}...", file=sys.stderr)
    corpus = load_corpus_index(args.corpus)
    print(f"Loaded {len(corpus)} documents", file=sys.stderr)

    # Benchmark sci-anonymizer
    print("Benchmarking sci-anonymizer...", file=sys.stderr)
    results = benchmark_sci_anonymizer(corpus, sci_only=args.sci_only)

    # Save results
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)

    print(f"Results written to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
