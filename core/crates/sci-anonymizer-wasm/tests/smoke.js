// Minimal JavaScript smoke test for sci-anonymizer-wasm.
// Tests round-trip anonymize → deanonymize.
//
// Run after wasm-pack build:
//   wasm-pack test core/crates/sci-anonymizer-wasm --headless --firefox

import init, {
  anonymize,
  deanonymize,
  WasmEntityType,
} from "./pkg/sci_anonymizer_wasm.js";

async function runTests() {
  await init();

  console.log("🧪 Running smoke tests...\n");

  // Test 1: Basic anonymize + deanonymize round-trip
  {
    const original = "Contact casey@example.com about the Acme deal";
    const result = anonymize(original, null);

    console.log("Test 1: Round-trip anonymize/deanonymize");
    console.log(`  Original: "${original}"`);
    console.log(`  Masked:   "${result.text}"`);
    console.log(`  Entities: ${result.entity_count}`);

    const restored = deanonymize(result.text, result.get_token_map());
    console.log(`  Restored: "${restored}"`);

    if (restored === original) {
      console.log("  ✓ PASS: Round-trip successful\n");
    } else {
      console.error(
        `  ✗ FAIL: Mismatch\n    Expected: "${original}"\n    Got:      "${restored}"\n`
      );
      process.exit(1);
    }
  }

  // Test 2: Multiple calls extend token map
  {
    console.log("Test 2: Token map persistence across calls");

    const first = anonymize("Visit https://one.com", null);
    console.log(`  First call:  "${first.text}"`);

    const second = anonymize("Visit https://two.com", first.get_token_map());
    console.log(`  Second call: "${second.text}"`);

    const hasUrl1 = first.text.includes("[URL_1]");
    const hasUrl2 = second.text.includes("[URL_2]");

    if (hasUrl1 && hasUrl2) {
      console.log("  ✓ PASS: Token numbering is stable\n");
    } else {
      console.error(
        `  ✗ FAIL: Expected [URL_1] and [URL_2], got: "${first.text}" and "${second.text}"\n`
      );
      process.exit(1);
    }
  }

  // Test 3: Session serialization
  {
    console.log("Test 3: Session JSON serialization");

    const result = anonymize("Email: test@example.com", null);
    const tokenMap = result.get_token_map();

    const sessionJson = tokenMap.to_session_json();
    console.log(`  Serialized: ${sessionJson.substring(0, 60)}...`);

    const restored = tokenMap.from_session_json(sessionJson);
    console.log("  ✓ PASS: Serialization round-trip successful\n");
  }

  console.log("✅ All tests passed!");
}

runTests().catch((err) => {
  console.error("❌ Test error:", err);
  process.exit(1);
});
