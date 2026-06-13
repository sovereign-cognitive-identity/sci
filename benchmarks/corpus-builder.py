#!/usr/bin/env python3
"""
Corpus builder for SCI-273 benchmark.

Assembles a labeled PII corpus from:
1. CoNLL-2003 NER dataset (public PII)
2. Edge-case corpus extracted from sci-anonymizer tests (SCI-195/196/197)

Outputs: corpus-index.jsonl with entity spans labeled by type.
"""

import json
import sys
from pathlib import Path
from typing import List, Dict, Any

# Try to import datasets; if unavailable, provide manual loading instructions
try:
    from datasets import load_dataset
    HAS_DATASETS = True
except ImportError:
    HAS_DATASETS = False
    print(
        "Warning: 'datasets' package not found. "
        "Install with: pip install datasets",
        file=sys.stderr
    )


def load_conll2003_subset(max_samples: int = 1000) -> List[Dict[str, Any]]:
    """
    Load CoNLL-2003 NER dataset from HuggingFace.

    Returns list of dicts:
    {
        "doc_id": "public:conll2003:0001",
        "text": "...",
        "entities": [
            {"start": 0, "end": 5, "type": "PERSON", "text": "..."},
            ...
        ]
    }
    """
    if not HAS_DATASETS:
        print(
            "Skipping CoNLL-2003: datasets package not installed.",
            file=sys.stderr
        )
        return []

    try:
        # The canonical `conll2003` dataset ships as a deprecated loading
        # script and no longer works with datasets>=3. Use a Parquet mirror
        # with the identical tag scheme (O, B-PER, I-PER, B-ORG, ...).
        dataset = load_dataset("tomaarsen/conll2003")
        train_split = dataset["train"]
    except Exception as e:
        print(f"Error loading CoNLL-2003: {e}", file=sys.stderr)
        return []

    docs = []
    tag2type = {
        "B-PER": "PERSON",
        "I-PER": "PERSON",
        "B-ORG": "ORG",
        "I-ORG": "ORG",
        "B-LOC": "PLACE",
        "I-LOC": "PLACE",
    }

    for idx, example in enumerate(train_split):
        if idx >= max_samples:
            break

        tokens = example["tokens"]
        ner_tags = example["ner_tags"]
        tag_names = train_split.features["ner_tags"].feature.names

        # Reconstruct text and span indices
        text = " ".join(tokens)
        entities = []

        # Exact char offset of each token in the joined text. Using token
        # positions (not re.search) avoids mis-locating entities whose text
        # repeats elsewhere in the sentence.
        token_starts = []
        pos = 0
        for tok in tokens:
            token_starts.append(pos)
            pos += len(tok) + 1  # +1 for the joining space

        i = 0
        while i < len(tokens):
            tag_idx = ner_tags[i]
            tag_name = tag_names[tag_idx]

            if tag_name != "O" and tag_name in tag2type:
                entity_type = tag2type[tag_name]
                entity_tokens = [tokens[i]]
                start_token = i

                # Accumulate consecutive I- tags of the same entity
                j = i + 1
                while j < len(tokens):
                    tag_idx_j = ner_tags[j]
                    tag_name_j = tag_names[tag_idx_j]

                    if tag_name_j.startswith("I-") and tag2type.get(tag_name_j) == entity_type:
                        entity_tokens.append(tokens[j])
                        j += 1
                    else:
                        break

                entity_text = " ".join(entity_tokens)
                start = token_starts[start_token]
                end = start + len(entity_text)
                entities.append({
                    "start": start,
                    "end": end,
                    "type": entity_type,
                    "text": entity_text,
                })

                i = j
            else:
                i += 1

        if entities:
            docs.append({
                "doc_id": f"public:conll2003:{idx:04d}",
                "text": text,
                "entities": entities,
            })

    return docs


def load_edge_case_corpus() -> List[Dict[str, Any]]:
    """
    Load edge-case corpus from sci-anonymizer tests.

    SCI-195: Poisoned Original Skip
    SCI-196: Compound Bleed
    SCI-197: Placeholder Leak
    """
    edge_cases = []

    # SCI-195: Poisoned original must not substitute
    edge_cases.append({
        "doc_id": "edge-case:sci195:001",
        "text": "hello [PERSON_1] world",
        "entities": [
            # No real entities; this tests the deanonymizer's defense
        ],
    })

    edge_cases.append({
        "doc_id": "edge-case:sci195:002",
        "text": '"Casey Zandbergen" replied',
        "entities": [
            {
                "start": 1,
                "end": 17,
                "type": "PERSON",
                "text": "Casey Zandbergen",
            }
        ],
    })

    # SCI-196: Compound bleed (PERSON first-name extension)
    edge_cases.append({
        "doc_id": "edge-case:sci196:001",
        "text": "Casey Zandbergen pinged them",
        "entities": [
            {
                "start": 0,
                "end": 16,
                "type": "PERSON",
                "text": "Casey Zandbergen",
            }
        ],
    })

    edge_cases.append({
        "doc_id": "edge-case:sci196:002",
        "text": "Contact John Smith at work",
        "entities": [
            {
                "start": 8,
                "end": 18,
                "type": "PERSON",
                "text": "John Smith",
            }
        ],
    })

    # SCI-197: Placeholder leak (second-pass anonymization)
    edge_cases.append({
        "doc_id": "edge-case:sci197:001",
        "text": "Email alice@example.com for details",
        "entities": [
            {
                "start": 6,
                "end": 23,
                "type": "EMAIL",
                "text": "alice@example.com",
            }
        ],
    })

    edge_cases.append({
        "doc_id": "edge-case:sci197:002",
        "text": "Call +1-555-123-4567 to confirm",
        "entities": [
            {
                "start": 5,
                "end": 20,
                "type": "PHONE",
                "text": "+1-555-123-4567",
            }
        ],
    })

    return edge_cases


def main():
    corpus_dir = Path(__file__).parent / "corpus"
    index_path = corpus_dir / "corpus-index.jsonl"

    print("Building corpus index...", file=sys.stderr)

    # Load both datasets
    public_docs = load_conll2003_subset(max_samples=1000)
    edge_case_docs = load_edge_case_corpus()

    all_docs = public_docs + edge_case_docs

    if not all_docs:
        print(
            "No documents loaded. Install 'datasets' to use CoNLL-2003: "
            "pip install datasets",
            file=sys.stderr
        )
        # Still write edge cases
        all_docs = edge_case_docs

    # Write JSONL index
    with open(index_path, "w") as f:
        for doc in all_docs:
            f.write(json.dumps(doc) + "\n")

    print(f"Wrote {len(all_docs)} documents to {index_path}", file=sys.stderr)
    print(
        f"  - Public datasets: {len(public_docs)} (CoNLL-2003)",
        file=sys.stderr
    )
    print(
        f"  - Edge cases: {len(edge_case_docs)} (SCI-195/196/197)",
        file=sys.stderr
    )


if __name__ == "__main__":
    main()
