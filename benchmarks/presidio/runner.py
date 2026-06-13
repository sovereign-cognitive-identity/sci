#!/usr/bin/env python3
"""
Optional Presidio comparison runner for SCI-273.

This script runs Presidio against the benchmark corpus INDEPENDENTLY.
It is NOT invoked by the main harness to avoid dependency conflicts.

Usage (manual, optional):
    cd benchmarks/presidio
    pip install presidio-analyzer presidio-anonymizer -q
    python3 runner.py --corpus ../corpus/corpus-index.jsonl
    # Results written to results.json

The main harness (../run.sh) will pick up results.json if present.
"""

import json
import sys
import argparse
from pathlib import Path
from typing import List, Dict, Any
from collections import defaultdict

# Import Presidio (optional; will fail gracefully if not installed)
try:
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    HAS_PRESIDIO = True
except ImportError:
    HAS_PRESIDIO = False


def load_corpus_index(path: str) -> List[Dict[str, Any]]:
    """Load corpus index from JSONL file."""
    docs = []
    with open(path) as f:
        for line in f:
            if line.strip():
                docs.append(json.loads(line))
    return docs


def run_presidio_analyzer(text: str) -> List[Dict[str, Any]]:
    """
    Run Presidio analyzer and extract entities.

    Returns list of entities:
    [
        {"start": 0, "end": 5, "type": "PERSON", "text": "..."},
        ...
    ]
    """
    if not HAS_PRESIDIO:
        print("Presidio not installed. Skipping.", file=sys.stderr)
        return []

    try:
        # Initialize Presidio
        provider = NlpEngineProvider(nlp_engine_name="spacy")
        nlp_engine = provider.create_engine()
        analyzer = AnalyzerEngine(nlp_engine=nlp_engine)

        # Run analyzer
        results = analyzer.analyze(text=text, language="en")

        # Convert to our format
        entities = []
        for result in results:
            entities.append({
                "start": result.start,
                "end": result.end,
                "type": result.entity_type,
                "text": text[result.start : result.end],
            })

        return entities
    except Exception as e:
        print(f"Error analyzing text: {e}", file=sys.stderr)
        return []


def benchmark_presidio(corpus: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Benchmark Presidio on the given corpus.

    Returns results in the same format as sci-anonymizer harness:
    {
        "PERSON": {"tp": ..., "precision": ..., ...},
        "ORG": {...},
        ...
    }
    """
    if not HAS_PRESIDIO:
        return {}

    metrics_by_type = defaultdict(lambda: {
        "tp": 0,
        "fp": 0,
        "fn": 0,
    })

    for doc in corpus:
        text = doc["text"]
        gold_entities = doc.get("entities", [])

        # Run Presidio
        detected_entities = run_presidio_analyzer(text)

        # Match entities
        for detected in detected_entities:
            entity_type = detected["type"]
            if detected in gold_entities:
                metrics_by_type[entity_type]["tp"] += 1
            else:
                metrics_by_type[entity_type]["fp"] += 1

        for gold in gold_entities:
            entity_type = gold["type"]
            if gold not in detected_entities:
                metrics_by_type[entity_type]["fn"] += 1

    # Compute precision/recall/f1
    results = {}
    for entity_type in sorted(metrics_by_type.keys()):
        metrics = metrics_by_type[entity_type]
        tp = metrics["tp"]
        fp = metrics["fp"]
        fn = metrics["fn"]

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        results[entity_type] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        }

    # Overall
    overall_tp = sum(m["tp"] for m in metrics_by_type.values())
    overall_fp = sum(m["fp"] for m in metrics_by_type.values())
    overall_fn = sum(m["fn"] for m in metrics_by_type.values())

    overall_precision = overall_tp / (overall_tp + overall_fp) if (overall_tp + overall_fp) > 0 else 0.0
    overall_recall = overall_tp / (overall_tp + overall_fn) if (overall_tp + overall_fn) > 0 else 0.0
    overall_f1 = 2 * (overall_precision * overall_recall) / (overall_precision + overall_recall) if (overall_precision + overall_recall) > 0 else 0.0

    results["overall"] = {
        "tp": overall_tp,
        "fp": overall_fp,
        "fn": overall_fn,
        "precision": round(overall_precision, 4),
        "recall": round(overall_recall, 4),
        "f1": round(overall_f1, 4),
    }

    return results


def main():
    parser = argparse.ArgumentParser(description="Presidio benchmark runner (optional)")
    parser.add_argument("--corpus", required=True, help="Path to corpus-index.jsonl")
    parser.add_argument("--output", default="results.json", help="Output file")

    args = parser.parse_args()

    if not HAS_PRESIDIO:
        print(
            "Presidio not installed. Install with:\n"
            "  pip install presidio-analyzer presidio-anonymizer",
            file=sys.stderr
        )
        sys.exit(1)

    # Load corpus
    print(f"Loading corpus from {args.corpus}...", file=sys.stderr)
    corpus = load_corpus_index(args.corpus)
    print(f"Loaded {len(corpus)} documents", file=sys.stderr)

    # Benchmark Presidio
    print("Running Presidio analyzer...", file=sys.stderr)
    results = benchmark_presidio(corpus)

    # Save results
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)

    print(f"Results written to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
