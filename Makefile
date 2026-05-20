.PHONY: release-local release-arm release-x86 release-all dist

HELPER_DIR := apps/sci-mac/SciHelper
VERSION     := $(shell cargo metadata --no-deps --manifest-path $(HELPER_DIR)/Cargo.toml --format-version 1 | python3 -c "import sys,json; print(json.load(sys.stdin)['packages'][0]['version'])")

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
