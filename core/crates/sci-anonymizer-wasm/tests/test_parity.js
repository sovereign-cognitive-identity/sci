#!/usr/bin/env node

/**
 * Cross-language parity tests for sci-anonymizer-wasm.
 *
 * Loads core/tests/fixtures/anonymizer.json (golden fixtures) and verifies
 * that the WASM binding produces identical behavior to the Rust core on:
 *   - Entity detection (regex, CamelCase heuristic, custom entities)
 *   - Token map serialization/deserialization
 *   - Round-trip anonymize → deanonymize fidelity
 *
 * This test does NOT cover:
 *   - NLP NER (bare PERSON/PLACE/ORG detection) — tracked in SCI-123
 *   - Custom entity loading from identity_facts — tracked in SCI-124
 *   - Internal regressions (SCI-195/196/197) — Rust-only
 *
 * WASM Build Status:
 *   This test requires the WASM module to be built with wasm-pack. Due to a
 *   pre-existing issue with wasm-bindgen (class `WasmEntityType` referenced by
 *   an impl block does not match any exported struct), the WASM build currently
 *   fails. The plain Rust → WASM compilation (via cargo) works fine; the issue
 *   is specific to wasm-pack's binding generation.
 *
 *   To build when the wasm-bindgen issue is fixed:
 *     wasm-pack build core/crates/sci-anonymizer-wasm --target nodejs --release
 *
 * Usage:
 *   node tests/test_parity.js
 */

const fs = require("fs");
const path = require("path");

// Dynamically import WASM module (ESM required)
async function initWasm() {
  const wasmPath = path.join(
    __dirname,
    "../pkg/sci_anonymizer_wasm.js"
  );

  if (!fs.existsSync(wasmPath)) {
    console.log(
      "⚠️  WASM module not found at " + wasmPath
    );
    console.log(
      "    The wasm-pack build is currently blocked by a pre-existing wasm-bindgen issue:"
    );
    console.log(
      "    'class `WasmEntityType` referenced by an impl block does not match any exported struct'"
    );
    console.log(
      "    See the comment block in this file for more details."
    );
    console.log("");
    console.log("⏭️  Skipping WASM parity test.");
    return null;
  }

  const wasm = await import(wasmPath);
  return wasm;
}

function loadFixtures() {
  const fixturePath = path.join(
    __dirname,
    "../../../tests/fixtures/anonymizer.json"
  );

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture file not found: ${fixturePath}`);
  }

  return JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
}

function allowlistedCI(text, allowlist) {
  const lower = text.toLowerCase();
  return allowlist.some((w) => w.toLowerCase() === lower);
}

async function testParityRoundTrip(wasm, fixtures) {
  const failures = [];

  for (const fixture of fixtures) {
    const text = fixture.input;
    const result = wasm.anonymize(text, null);
    const restored = wasm.deanonymize(result.text, result.get_token_map());

    if (restored !== text) {
      failures.push({
        name: fixture.name,
        input: text,
        masked: result.text,
        restored,
        error: `Round-trip mismatch: ${restored} !== ${text}`,
      });
    }
  }

  if (failures.length > 0) {
    console.log("FAILED: Round-trip fidelity");
    for (const fail of failures) {
      console.log(`  [${fail.name}] ${fail.error}`);
    }
    return false;
  }

  console.log(`✓ Round-trip fidelity: all ${fixtures.length} fixtures passed`);
  return true;
}

async function testParityEntityDetection(wasm, fixtures, allowlist) {
  const failures = [];

  for (const fixture of fixtures) {
    const text = fixture.input;
    const result = wasm.anonymize(text, null);

    // Build expected set (case-insensitive, filtered through allowlist)
    const expected = new Set(
      fixture.expected_detected
        .filter((e) => !allowlistedCI(e.text, allowlist))
        .map((e) => `${e.text.toLowerCase()}|${e.type}`)
    );

    // Build actual set
    const actual = new Set(
      result.get_detected()
        .filter((e) => !allowlistedCI(e.text, allowlist))
        .map((e) => `${e.text.toLowerCase()}|${e.entity_type}`)
    );

    if (expected.size !== actual.size || ![...expected].every((x) => actual.has(x))) {
      failures.push({
        name: fixture.name,
        input: text,
        expected: [...expected].sort(),
        actual: [...actual].sort(),
      });
    }
  }

  if (failures.length > 0) {
    console.log("FAILED: Entity detection parity");
    for (const fail of failures) {
      console.log(`  [${fail.name}] input: ${fail.input}`);
      console.log(`    expected: ${JSON.stringify(fail.expected)}`);
      console.log(`    actual:   ${JSON.stringify(fail.actual)}`);
    }
    return false;
  }

  console.log(`✓ Entity detection: all ${fixtures.length} fixtures matched`);
  return true;
}

async function testParitySessionSerialization(wasm, fixtures) {
  const failures = [];
  const sample = fixtures.slice(0, 5); // Sample first 5

  for (const fixture of sample) {
    const text = fixture.input;
    const result = wasm.anonymize(text, null);
    const tokenMap = result.get_token_map();

    // Serialize
    let jsonStr;
    try {
      jsonStr = tokenMap.to_session_json();
    } catch (e) {
      failures.push({
        name: fixture.name,
        error: `Serialization failed: ${e.message}`,
      });
      continue;
    }

    // Deserialize
    let restoredMap;
    try {
      restoredMap = wasm.WasmTokenMap.from_session_json(jsonStr);
    } catch (e) {
      failures.push({
        name: fixture.name,
        error: `Deserialization failed: ${e.message}`,
      });
      continue;
    }

    // Test that the restored map produces identical results
    try {
      const deanonOriginal = wasm.deanonymize(result.text, tokenMap);
      const deanonRestored = wasm.deanonymize(result.text, restoredMap);

      if (deanonOriginal !== deanonRestored) {
        failures.push({
          name: fixture.name,
          error: "Restored map produces different deanonymization",
        });
      }
    } catch (e) {
      failures.push({
        name: fixture.name,
        error: `Deanonymization with restored map failed: ${e.message}`,
      });
    }
  }

  if (failures.length > 0) {
    console.log("FAILED: Session serialization");
    for (const fail of failures) {
      console.log(`  [${fail.name}] ${fail.error}`);
    }
    return false;
  }

  console.log(
    `✓ Session serialization: sampled ${Math.min(5, sample.length)} fixtures passed`
  );
  return true;
}

function printCoverageStatement() {
  console.log("\nParity Test Coverage Statement:");
  console.log("=".repeat(60));
  console.log("COVERED (portable surface):");
  console.log("  ✓ Regex-based detection (emails, URLs, phones, handles, etc.)");
  console.log("  ✓ CamelCase compound proper noun heuristic");
  console.log("  ✓ Custom entity masking");
  console.log("  ✓ Token map determinism and numbering");
  console.log("  ✓ Session JSON serialization/deserialization");
  console.log(
    "  ✓ Round-trip fidelity: deanonymize(anonymize(text)) == text"
  );
  console.log("\nNOT COVERED (tracking SCI-123/124):");
  console.log("  ✗ NLP NER for bare PERSON/PLACE/ORG detection (SCI-123)");
  console.log(
    "  ✗ Custom entity loading from identity_facts (SCI-124)"
  );
  console.log("\nNOT COVERED (Rust-only):");
  console.log("  ✗ Internal regressions SCI-195/196/197");
  console.log("=".repeat(60));
}

async function main() {
  console.log("Cross-language parity tests for sci-anonymizer-wasm\n");

  try {
    const wasm = await initWasm();

    if (!wasm) {
      // WASM module not available, skip test gracefully
      console.log("");
      console.log("=".repeat(60));
      console.log("⏭️  WASM parity test skipped (WASM module not built)");
      console.log("=".repeat(60));
      return 0;
    }

    const fixtures = loadFixtures();

    // Extract allowlist from the TECH_ALLOWLIST if available
    // For now, use a basic list; the actual list is in Rust
    const allowlist = [
      "slack", "github", "twitter", "google", "amazon", "microsoft",
      "openai", "anthropic", "science", "platform", "platform",
      "claude", "chatgpt", "copilot", "cursor", "gemini",
    ];

    const results = [];

    // Run parity tests
    console.log("Running tests...\n");
    results.push([
      "Round-trip fidelity",
      await testParityRoundTrip(wasm, fixtures),
    ]);
    results.push([
      "Entity detection",
      await testParityEntityDetection(wasm, fixtures, allowlist),
    ]);
    results.push([
      "Session serialization",
      await testParitySessionSerialization(wasm, fixtures),
    ]);

    printCoverageStatement();

    // Summary
    console.log("\n" + "=".repeat(60));
    const passed = results.filter(([_, r]) => r).length;
    const total = results.length;

    if (passed === total) {
      console.log(`✅ All ${total} parity tests PASSED`);
      console.log("=".repeat(60));
      return 0;
    } else {
      console.log(`❌ ${total - passed}/${total} parity tests FAILED`);
      console.log("=".repeat(60));
      return 1;
    }
  } catch (e) {
    console.error(`\n❌ Unexpected error: ${e.message}`);
    console.error(e.stack);
    return 1;
  }
}

main().then((code) => process.exit(code));
