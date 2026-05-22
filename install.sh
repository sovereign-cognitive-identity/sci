#!/usr/bin/env bash
# Sci installer — downloads the binary + native addons for your platform.
# Usage: curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/install.sh | bash

set -euo pipefail

REPO="sovereign-cognitive-identity/sci"
INSTALL_DIR="${SCI_INSTALL_DIR:-/usr/local/lib/sci}"
BIN_DIR="${SCI_BIN_DIR:-/usr/local/bin}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac
case "$OS" in
  darwin) PLATFORM="${ARCH}-apple-darwin" ;;
  linux)  PLATFORM="${ARCH}-linux" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Find latest release
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
TARBALL="sci-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

echo "Installing Sci ${VERSION} for ${PLATFORM}..."

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

curl -fsSL "$URL" -o "$TMP/$TARBALL"
tar -xzf "$TMP/$TARBALL" -C "$TMP"

# Install binary + native addons together (both needed at same location)
sudo mkdir -p "$INSTALL_DIR"
sudo cp "$TMP/sci/sci" "$INSTALL_DIR/sci"
sudo cp -r "$TMP/sci/node_modules" "$INSTALL_DIR/node_modules"
sudo chmod +x "$INSTALL_DIR/sci"

# Wrapper at /usr/local/bin that sets NODE_PATH
sudo tee "$BIN_DIR/sci" > /dev/null << WRAPPER
#!/bin/bash
export NODE_PATH="$INSTALL_DIR/node_modules"
exec "$INSTALL_DIR/sci" "\$@"
WRAPPER
sudo chmod +x "$BIN_DIR/sci"

echo "✓ Sci ${VERSION} installed to ${INSTALL_DIR}"
echo "  Run: sci --setup --token <your-token>"
