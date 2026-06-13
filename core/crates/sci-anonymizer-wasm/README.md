# sci-anonymizer-wasm

WASM + npm bindings for reversible entity anonymization and token mapping for LLM round-trips.

Published as npm package: **`@sovereign-cognitive-identity/anonymizer`**

## Building

### Prerequisites

1. Install Rust (1.95+) and the WASM target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

2. For bundling the `.wasm` module into npm, install `wasm-pack`:
   ```bash
   cargo install wasm-pack
   ```

### Build Commands

From `core/` directory (the workspace root):

#### Plain Cargo build (quick verification)

```bash
# Debug build
nice -n 19 cargo build -p sci-anonymizer-wasm --target wasm32-unknown-unknown

# Release build (optimized)
nice -n 19 cargo build -p sci-anonymizer-wasm --target wasm32-unknown-unknown --release
```

The `.wasm` module will be in `target/wasm32-unknown-unknown/release/sci_anonymizer_wasm.wasm`.

**Current build results:**
- Release binary size: ~1.3 MB
- With brotli compression for npm distribution: ~300-400 KB expected

#### wasm-pack build (recommended for npm publishing)

If `wasm-pack` is installed:

```bash
# Build for bundler (Webpack, esbuild, etc.)
nice -n 19 wasm-pack build core/crates/sci-anonymizer-wasm --target bundler --release

# Build for web (direct browser use)
nice -n 19 wasm-pack build core/crates/sci-anonymizer-wasm --target web --release

# Build for Node.js
nice -n 19 wasm-pack build core/crates/sci-anonymizer-wasm --target nodejs --release
```

The generated `pkg/` directory will contain:
- `sci_anonymizer_wasm.wasm` (the compiled module)
- `sci_anonymizer_wasm.js` (WASM wrapper)
- `sci_anonymizer_wasm.d.ts` (TypeScript definitions)
- `package.json` (ready for npm publish)

## API

### `anonymize(text: string, existing?: TokenMap): AnonymizeResult`

Detect entities in `text` and replace them with stable placeholder tokens.

```typescript
const result = anonymize("Email casey@example.com about Acme deal", null);
// result.text = "Email EMAIL_1 about ORG_1 deal"
// result.entity_count = 2
// result.detected = [Entity, Entity]
```

### `anonymize_with_custom(text: string, existing?: TokenMap, customEntities: Entity[]): AnonymizeResult`

Same as `anonymize`, plus caller-supplied custom entities to mask.

```typescript
const custom = [{ text: "Acme", entity_type: WasmEntityType.Org }];
const result = anonymize_with_custom(text, null, custom);
```

### `deanonymize(text: string, tokenMap: TokenMap): string`

Reverse substitution: replace placeholder tokens with real entities.

```typescript
const masked = result.text;
const restored = deanonymize(masked, result.get_token_map());
// Reconstructs original entities (round-trip fidelity guaranteed)
```

### `build_token_map(entities: Entity[], existing?: TokenMap): TokenMap`

Build a token map from detected entities with deterministic per-type numbering.

```typescript
const map = build_token_map([...], null);
```

### `apply_token_map(text: string, tokenMap: TokenMap): string`

Apply forward substitutions (entity → token) to text.

```typescript
const masked = apply_token_map(originalText, tokenMap);
```

### Session Serialization

```typescript
// Serialize to versioned JSON
const sessionJson = tokenMap.to_session_json();

// Deserialize from versioned JSON
const restored = TokenMap.from_session_json(sessionJson);

// Get the session format version
const version = get_session_format_version(); // returns 1
```

## Types

### `EntityType`

Enum for entity classification:
- `Person`, `Place`, `Org`, `Project`
- `Email`, `Phone`, `Url`, `Handle`
- `Secret`, `IpAddress`

### `Entity`

A detected entity span:
```typescript
{
  text: string;
  entity_type: EntityType;
}
```

### `TokenMap`

Bidirectional entity ↔ token mapping. Supports session serialization.

```typescript
// Create empty map
const map = new TokenMap();

// Serialize/deserialize
const json = map.to_session_json();
const restored = TokenMap.from_session_json(json);
```

### `AnonymizeResult`

Output of `anonymize*`:
```typescript
{
  text: string;               // masked text
  entity_count: number;       // number of entities found
  get_token_map(): TokenMap;  // bidirectional mapping
  get_detected(): Entity[];   // detected entities
}
```

## Testing

Run the smoke test after building:

```bash
# Node.js environment (simplest)
node tests/smoke.js

# Or via wasm-pack test harness
nice -n 19 wasm-pack test --node core/crates/sci-anonymizer-wasm
```

The smoke test verifies:
1. Round-trip anonymize → deanonymize
2. Token map persistence across calls
3. Session JSON serialization

## Design Notes

### serde_wasm_bindgen for TokenMap

The `TokenMap` type contains Rust `HashMap` structures. WASM doesn't have a native HashMap representation, so `serde_wasm_bindgen` is used to serialize/deserialize across the JS boundary. This trades a small serialization cost for clean, ergonomic JS APIs.

### Fact<'a> and Borrowed References

The upstream `sci-anonymizer` uses `Fact<'a>` with borrowed string references for zero-copy processing in the Rust layer. WASM cannot safely export borrowed references across the boundary, so the public surface only exposes owned types (`String`, `Entity` with owned `text`).

### Missing NER Capability (SCI-123 Gap)

The WASM bindings inherit the SCI-123 gap from `sci-anonymizer`: bare PERSON name detection (e.g., "Casey Zandbergen") requires an NLP model (`compromise.js` in TypeScript, ONNX in Rust). This crate provides only the portable surface:

- ✓ Regex extraction (emails, URLs, phones, bare domains, social handles)
- ✓ CamelCase heuristic (e.g., "OpenClaw")
- ✓ Custom entity masking
- ✗ NER for bare PERSON/PLACE/ORG names (awaiting SCI-123 resolution)

### Binary Size Optimization

Profile settings target 300-500 KB for the `.wasm` module:

```toml
[profile.release]
opt-level     = "z"
lto           = "fat"
codegen-units = 1
strip         = "symbols"
panic         = "abort"
```

## License

Licensed under either Apache License 2.0 or MIT, at your option. See `LICENSE-APACHE` and `LICENSE-MIT` in the workspace root.

This permissive licensing allows the crate to be vendored into other tools and projects.

## Versioning

### Crate Version (npm)

Pre-1.0 (`0.x`): minor bumps may contain breaking changes. See `CHANGELOG.md` for breaking-change notes.

### Session Format Version

The `SESSION_FORMAT_VERSION` constant (currently `1`) governs only the persisted session envelope. A build reads any envelope with `version <= SESSION_FORMAT_VERSION` and rejects anything newer. Bump only on breaking changes to the serialized shape.

## Implementation Reference

- Rust source: `core/crates/sci-anonymizer/` (portable core)
- WASM source: `core/crates/sci-anonymizer-wasm/` (this directory)
- TypeScript reference: `packages/core/src/anonymizer.ts` (legacy)
- Fixtures: `core/tests/parity/` (algorithm parity tests)
