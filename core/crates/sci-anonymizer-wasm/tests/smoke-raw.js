#!/usr/bin/env node

/**
 * Offline smoke test for sci-anonymizer-wasm.
 * Verifies the WASM module can be compiled and exports expected functions.
 *
 * Usage:
 *   node tests/smoke-raw.js
 *
 * Requirements:
 *   - WASM module built: cargo build -p sci-anonymizer-wasm --target wasm32-unknown-unknown
 *   - Node.js with WebAssembly support (all modern versions)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the raw .wasm module from the workspace target directory
const wasmPath = path.join(
  __dirname,
  "../../../target/wasm32-unknown-unknown/release/sci_anonymizer_wasm.wasm"
);

if (!fs.existsSync(wasmPath)) {
  console.error(
    `❌ WASM module not found at ${wasmPath}\n` +
      "   Run: cd core && cargo build -p sci-anonymizer-wasm --target wasm32-unknown-unknown --release"
  );
  process.exit(1);
}

const wasmBuffer = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBuffer);

console.log("✓ WASM module loaded successfully");
console.log(`  Binary size: ${(wasmBuffer.length / 1024).toFixed(1)} KB`);

// Inspect module exports without instantiation (avoids needing imports)
const exports = WebAssembly.Module.exports(wasmModule).map(e => e.name);
console.log(`  Exports: ${exports.length} items\n`);

// Verify key function exports exist
const expectedFunctions = [
  "anonymize",
  "deanonymize",
  "anonymize_with_custom",
  "build_token_map",
  "apply_token_map",
  "get_session_format_version",
];

const missingFunctions = expectedFunctions.filter(
  (name) => !exports.includes(name)
);

if (missingFunctions.length > 0) {
  console.error(`❌ Missing function exports: ${missingFunctions.join(", ")}`);
  console.error(`   Available exports: ${exports.join(", ")}`);
  process.exit(1);
}

console.log("✅ All expected function exports are present:");
expectedFunctions.forEach(f => console.log(`   - ${f}`));

console.log(`\n📌 Note: Full functional testing with actual calls requires wasm-pack`);
console.log(`   to generate JavaScript bindings. Run:`);
console.log(`      cargo install wasm-pack`);
console.log(`      wasm-pack build core/crates/sci-anonymizer-wasm --target nodejs --release`);

