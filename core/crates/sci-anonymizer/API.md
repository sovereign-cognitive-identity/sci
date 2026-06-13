# sci-anonymizer — Public API

Stable, embeddable API for reversible entity anonymization and token mapping
for LLM round-trips. `anonymize` outbound → infer → `deanonymize` inbound.

- **Crate version:** 0.1.0
- **Edition:** 2024 · **MSRV:** 1.95
- **License:** Apache-2.0 OR MIT

## Core functions

```rust
/// Detect entities in `text` and replace them with stable placeholder tokens.
/// Pass `existing` to extend a prior session's TokenMap so the same entity
/// keeps the same token across turns (None starts a fresh session).
pub fn anonymize(text: &str, existing: Option<TokenMap>) -> AnonymizeResult;

/// Same as `anonymize`, plus caller-supplied domain entities that should be
/// masked in addition to the built-in detectors.
pub fn anonymize_with_custom(
    text: &str,
    existing: Option<TokenMap>,
    custom_entities: &[Entity],
) -> AnonymizeResult;

/// Reverse substitution: replace placeholder tokens in `text` with the real
/// entities recorded in `token_map`. The inverse of `anonymize`.
pub fn deanonymize(text: &str, token_map: &TokenMap) -> String;

/// Build (or extend) a TokenMap from detected entities with deterministic
/// per-type numbering. Lower-level building block used by `anonymize`.
pub fn build_token_map(entities: &[Entity], existing: Option<TokenMap>) -> TokenMap;

/// Apply a TokenMap's forward substitutions to `text` (entity → token).
pub fn apply_token_map(text: &str, token_map: &TokenMap) -> String;
```

## Types

- **`EntityType`** — entity classification: PERSON, PLACE, ORG, PROJECT, EMAIL,
  PHONE, URL, HANDLE, SECRET, IP_ADDRESS. `token_prefix()` returns the
  placeholder prefix used for each type.
- **`Entity`** — a detected span (text + `EntityType`).
- **`TokenMap`** — bidirectional entity ↔ token mapping. `TokenMap::new()` for
  an empty map.
- **`AnonymizeResult`** — output of `anonymize*`: the masked text, the updated
  `TokenMap`, an entity count, and the detected entities.

## Session serialization (versioned)

The on-the-wire session format is explicitly versioned so stored sessions
survive crate upgrades.

```rust
pub const SESSION_FORMAT_VERSION: u32 = 1;

impl TokenMap {
    /// Serialize this map into a versioned JSON envelope.
    pub fn to_session_json(&self) -> Result<String, SessionError>;

    /// Parse a versioned JSON envelope back into a TokenMap.
    /// Returns `SessionError::UnsupportedVersion` if the envelope was written
    /// by a newer format than this build supports (forward-incompatible).
    pub fn from_session_json(json: &str) -> Result<TokenMap, SessionError>;
}

pub enum SessionError { /* Malformed JSON | UnsupportedVersion { found, supported } */ }
pub struct SerializedSession { /* versioned envelope: { version, map } */ }
```

**Versioning contract:** a build reads any envelope with `version <=
SESSION_FORMAT_VERSION` and rejects anything newer. Bump
`SESSION_FORMAT_VERSION` only on a breaking change to the serialized shape;
additive fields that older builds can ignore do not require a bump.

## Semver policy

- Pre-1.0 (`0.x`): a minor bump (`0.x → 0.(x+1)`) may contain breaking changes;
  patch bumps are backward-compatible. Each release notes breaking changes in
  `CHANGELOG.md`.
- `SESSION_FORMAT_VERSION` is independent of the crate version and governs only
  the persisted session envelope, per the contract above.

## Guarantees

- **Round-trip fidelity:** for any `text`, `deanonymize(anonymize(text).0, &map)`
  reconstructs the original entities.
- **Code regions preserved:** content inside markdown fences and inline
  backticks is never masked.

## Embed example (5 lines)

```rust
use sci_anonymizer::{anonymize, deanonymize};

let result = anonymize("Email casey@example.com about the Acme deal", None);
let masked = result.text;                       // send `masked` to the LLM
// ... model replies referencing the same tokens ...
let restored = deanonymize(&model_reply, &result.token_map);
```
