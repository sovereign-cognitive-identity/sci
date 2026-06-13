.PHONY: release-local release-arm release-x86 release-all dist \
		test-parity-all test-parity-rust test-parity-py test-parity-wasm

HELPER_DIR := apps/sci-mac/SciHelper
VERSION     := $(shell cargo metadata --no-deps --manifest-path $(HELPER_DIR)/Cargo.toml --format-version 1 | python3 -c "import sys,json; print(json.load(sys.stdin)['packages'][0]['version'])")

# ── Test Targets ────────────────────────────────────────────────────────────
# Cross-language parity tests for sci-anonymizer across Rust, WASM, and Python.
# See core/crates/sci-anonymizer-*/tests/test_parity.* for implementation details.

test-parity-rust:
	@echo "Running Rust parity tests..."
	@echo "Covers: regex detection, CamelCase heuristic, round-trip fidelity, token map determinism"
	cd core && nice -n 19 cargo test --test parity parity_

test-parity-py:
	@echo "Running Python parity tests..."
	@if command -v python3 >/dev/null 2>&1; then \
		cd core/crates/sci-anonymizer-py && \
		if [ ! -d .venv ]; then \
			python3 -m venv .venv; \
		fi && \
		. .venv/bin/activate && \
		pip install -q maturin 2>/dev/null || true && \
		nice -n 19 maturin develop -q 2>/dev/null || { \
			echo "⚠️  maturin develop failed; attempting with --release..."; \
			nice -n 19 maturin develop --release -q || true; \
		} && \
		python3 tests/test_parity.py; \
	else \
		echo "⚠️  python3 not found; skipping Python parity test"; \
		exit 0; \
	fi

test-parity-wasm:
	@echo "Running WASM parity tests..."
	@if command -v wasm-pack >/dev/null 2>&1; then \
		cd core/crates/sci-anonymizer-wasm && \
		nice -n 19 wasm-pack build --target nodejs --release --no-opt 2>/dev/null || { \
			echo "❌  wasm-pack build failed"; \
			exit 1; \
		}; \
		node tests/test_parity.js \
	else \
		echo "⚠️  wasm-pack not found; skipping WASM parity test"; \
		echo "    Install with: cargo install wasm-pack"; \
		echo "    Also requires: rustup target add wasm32-unknown-unknown"; \
		exit 0; \
	fi

test-parity-all: test-parity-rust test-parity-py test-parity-wasm
	@echo ""
	@echo "✅ All available parity tests completed"
	@echo "   (some tests may have been skipped if toolchains are not installed)"

# ── Release Targets ──────────────────────────────────────────────────────────

dist:
	mkdir -p dist

release-arm: dist
	cargo build --release --manifest-path $(HELPER_DIR)/Cargo.toml --target aarch64-apple-darwin
	cp $(HELPER_DIR)/target/aarch64-apple-darwin/release/sci-helper dist/sci-helper-aarch64-apple-darwin

release-x86: dist
	cargo build --release --manifest-path $(HELPER_DIR)/Cargo.toml --target x86_64-apple-darwin
	cp $(HELPER_DIR)/target/x86_64-apple-darwin/release/sci-helper dist/sci-helper-x86_64-apple-darwin

release-all: release-arm release-x86
	@echo "Built v$(VERSION)"
	shasum -a 256 dist/sci-helper-* > dist/SHA256SUMS
