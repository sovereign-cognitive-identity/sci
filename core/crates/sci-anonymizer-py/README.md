# sci-anonymizer-py

PyO3 bindings for `sci-anonymizer` — reversible entity anonymization for LLM round-trips.

Compiled to platform-specific wheels using `maturin` with abi3 (stable ABI), so a single wheel covers Python 3.10+.

## Installation (from source)

### Prerequisites

- Python 3.10+
- Rust 1.95+
- `maturin` (install via `pipx install maturin` or `pip install maturin`)

### Build and install in a venv

```bash
cd core/crates/sci-anonymizer-py

# Create or activate a Python venv
python3 -m venv .venv
source .venv/bin/activate  # on Windows: .venv\Scripts\activate

# Install maturin if not already present
pip install maturin

# Build and install the wheel into the venv
maturin develop

# Verify installation
python -c "import sci_anonymizer; print(sci_anonymizer.SESSION_FORMAT_VERSION)"
```

## Quick Start

```python
from sci_anonymizer import (
    anonymize, deanonymize,
    Entity, EntityType,
)

# Anonymize text
text = "Email casey@example.com about the Acme project deal"
result = anonymize(text)

print(result.text)
# Output: Email EMAIL_1 about the PROJECT_1 deal

# Deanonymize (reverse the tokens back to real entities)
model_reply = "I'll contact EMAIL_1 about PROJECT_1 next week"
restored = deanonymize(model_reply, result.token_map)

print(restored)
# Output: I'll contact casey@example.com about Acme next week

# Use custom entities (domain-specific terms)
custom = [Entity("InternalCodeXYZ", EntityType.Secret)]
result = anonymize(text, custom_entities=custom)
```

## API Overview

### Core Functions

- **`anonymize(text, existing=None)`** — Detect entities and replace with tokens.
- **`anonymize_with_custom(text, existing=None, custom_entities=None)`** — Same + custom entities.
- **`deanonymize(text, token_map)`** — Reverse: tokens → entities.
- **`build_token_map(entities, existing=None)`** — Lower-level: build a token map from entities.
- **`apply_token_map(text, token_map)`** — Lower-level: apply substitutions to text.

### Types

- **`EntityType`** — Enum: `Person`, `Place`, `Org`, `Project`, `Email`, `Phone`, `Url`, `Handle`, `Secret`, `IpAddress`.
- **`Entity`** — A detected span: `Entity(text, entity_type)`.
- **`TokenMap`** — Bidirectional mapping. Can serialize/deserialize:
  - `token_map.to_session_json()` → JSON string (versioned envelope).
  - `TokenMap.from_session_json(json_str)` → TokenMap (raises `ValueError` if unsupported version).
- **`AnonymizeResult`** — Output of `anonymize*` with `.text`, `.token_map`, `.entity_count`, `.entities`.

### Constants

- **`SESSION_FORMAT_VERSION`** — Current session format version (int). See session serialization contract in `../sci-anonymizer/API.md`.

## Session Persistence

```python
# Serialize a token map for storage
json_str = result.token_map.to_session_json()
# Save json_str to disk/database

# Later, restore and extend
token_map = TokenMap.from_session_json(json_str)
next_result = anonymize(new_text, existing=token_map)
# Same entity will get the same token as before
```

## Testing

Run the Python smoke test:

```bash
cd core/crates/sci-anonymizer-py
python tests/test_smoke.py
```

The smoke test validates:
- Round-trip fidelity: `deanonymize(anonymize(text).text, map) == text`
- Multiple entity types detected correctly
- Session serialization/deserialization
- Custom entities

## Limitations

This binding wraps the portable regex and CamelCase entity detection from `sci-anonymizer`. It does **not** include:

- **NLP NER** (Named Entity Recognition for PERSON/PLACE/ORG): Tracked in SCI-123.
  The Rust port uses a CamelCase heuristic to catch compound proper nouns,
  but bare "John Doe" style names are not detected without an NER model.
- **Custom entity loading from identity_facts**: Tracked in SCI-124.
  Users supply custom entities via the `custom_entities` parameter.

For production use with full NER, integrate with the Rust core directly or
patch this layer with the SCI-123/124 implementations when available.

## License

Licensed under Apache-2.0 OR MIT, same as `sci-anonymizer`.
