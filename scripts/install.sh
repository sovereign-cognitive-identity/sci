#!/usr/bin/env bash
# Sci installer — alpha release, macOS only.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/scripts/install.sh | bash
#   ./scripts/install.sh                          # auto-detect arch, download latest
#   ./scripts/install.sh /path/to/tarball.tar.gz  # use a local tarball
#
# Proxy note: targets :3001 (sci-helper Rust binary). Requires SCI-239 fix
# before the Rust helper proxy is fully functional. The node agent runs on
# :8080 as a fallback. Both are installed and supervised by launchd.

set -euo pipefail

# ── color helpers ─────────────────────────────────────────────────────────────

green() { printf '  \033[32m✓\033[0m  %s\n' "$1"; }
red()   { printf '  \033[31m✗\033[0m  %s\n' "$1"; }
warn()  { printf '  \033[33m⚠\033[0m  %s\n' "$1"; }
info()  { printf '  \033[34m→\033[0m  %s\n' "$1"; }
banner(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── platform check ────────────────────────────────────────────────────────────

OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  red "Sci alpha is macOS only. Linux support is planned for beta."
  exit 1
fi
green "Platform: macOS"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ARCH_LABEL="arm64" ;;
  x86_64) ARCH_LABEL="x86_64" ;;
  *)
    red "Unsupported CPU architecture: $ARCH"
    exit 1
    ;;
esac
green "Architecture: $ARCH_LABEL"

# ── constants ─────────────────────────────────────────────────────────────────

REPO="sovereign-cognitive-identity/sci"
HOME_DIR="$HOME"
SCI_DIR="$HOME_DIR/.sci"
BIN_DIR="$HOME_DIR/.sci/bin"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"

# ── tarball source ────────────────────────────────────────────────────────────

banner "Sci Installer"

LOCAL_TARBALL="${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "$LOCAL_TARBALL" ]]; then
  if [[ ! -f "$LOCAL_TARBALL" ]]; then
    red "Local tarball not found: $LOCAL_TARBALL"
    exit 1
  fi
  TARBALL_PATH="$LOCAL_TARBALL"
  green "Using local tarball: $TARBALL_PATH"
else
  info "Fetching latest release info from GitHub..."
  if ! command -v curl &>/dev/null; then
    red "curl is required but not found"
    exit 1
  fi
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | cut -d'"' -f4)"
  if [[ -z "$VERSION" ]]; then
    red "Could not fetch latest release version from GitHub"
    exit 1
  fi
  TARBALL_NAME="sci-darwin-${ARCH_LABEL}-${VERSION}.tar.gz"
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL_NAME}"
  info "Downloading $TARBALL_NAME..."
  curl -fsSL --progress-bar "$URL" -o "$TMP/$TARBALL_NAME"
  TARBALL_PATH="$TMP/$TARBALL_NAME"
  green "Downloaded $TARBALL_NAME ($VERSION)"
fi

# ── extract tarball ───────────────────────────────────────────────────────────

banner "Extracting"

mkdir -p "$BIN_DIR"

info "Extracting to $BIN_DIR..."
tar -xzf "$TARBALL_PATH" -C "$TMP"

# Tarball structure: sci/sci, sci/node_modules/, sci/mcp/
EXTRACT_ROOT="$TMP/sci"

if [[ ! -d "$EXTRACT_ROOT" ]]; then
  red "Unexpected tarball structure — expected 'sci/' root directory"
  exit 1
fi

# sci binary
if [[ -f "$EXTRACT_ROOT/sci" ]]; then
  cp "$EXTRACT_ROOT/sci" "$BIN_DIR/sci"
  chmod +x "$BIN_DIR/sci"
  green "Installed: $BIN_DIR/sci"
else
  warn "No 'sci' binary in tarball — skipping"
fi

# sci-helper Rust binary
if [[ -f "$EXTRACT_ROOT/sci-helper" ]]; then
  cp "$EXTRACT_ROOT/sci-helper" "$BIN_DIR/sci-helper"
  chmod +x "$BIN_DIR/sci-helper"
  green "Installed: $BIN_DIR/sci-helper"
else
  warn "No 'sci-helper' binary in tarball — skipping (will use existing if present)"
fi

# node_modules (native addons)
if [[ -d "$EXTRACT_ROOT/node_modules" ]]; then
  rm -rf "$BIN_DIR/node_modules"
  cp -r "$EXTRACT_ROOT/node_modules" "$BIN_DIR/node_modules"
  green "Installed: $BIN_DIR/node_modules/"
fi

# mcp/
if [[ -d "$EXTRACT_ROOT/mcp" ]]; then
  rm -rf "$BIN_DIR/mcp"
  cp -r "$EXTRACT_ROOT/mcp" "$BIN_DIR/mcp"
  green "Installed: $BIN_DIR/mcp/"
fi

# ── PATH setup ────────────────────────────────────────────────────────────────

banner "PATH Configuration"

add_to_path() {
  local rcfile="$1"
  local export_line='export PATH="$HOME/.sci/bin:$PATH"'
  if [[ -f "$rcfile" ]] && grep -qF '.sci/bin' "$rcfile"; then
    green "PATH already configured in $rcfile"
  else
    printf '\n# Sci CLI\n%s\n' "$export_line" >> "$rcfile"
    green "Added $BIN_DIR to PATH in $rcfile"
  fi
}

add_to_path "$HOME_DIR/.zshrc"
add_to_path "$HOME_DIR/.bashrc"

export PATH="$BIN_DIR:$PATH"

# ── CA certificate ────────────────────────────────────────────────────────────

banner "CA Certificate"

CA_CERT="$SCI_DIR/ca.crt"
HELPER_CA="$SCI_DIR/helper-ca/ca.crt"
CA_BUNDLE="$SCI_DIR/ca-bundle.crt"

# Generate CA if not present (node agent generates it on first run)
if [[ ! -f "$CA_CERT" ]]; then
  info "CA cert not found — running sci to generate it..."
  if [[ -x "$BIN_DIR/sci" ]]; then
    "$BIN_DIR/sci" up --init-only 2>/dev/null || true
  fi
fi

if [[ -f "$CA_CERT" ]]; then
  green "CA cert present at $CA_CERT"
else
  warn "CA cert not yet generated at $CA_CERT (will be created on first 'sci up')"
fi

# Build trust bundle (node CA + helper CA)
if [[ -f "$CA_CERT" && -f "$HELPER_CA" ]]; then
  cat "$CA_CERT" "$HELPER_CA" > "$CA_BUNDLE"
  green "Trust bundle rebuilt: $CA_BUNDLE"
elif [[ -f "$CA_CERT" ]]; then
  cp "$CA_CERT" "$CA_BUNDLE"
  green "Trust bundle (node CA only): $CA_BUNDLE"
fi

# Add to macOS System Keychain
if [[ -f "$CA_CERT" ]]; then
  info "Adding CA to macOS System Keychain (requires sudo)..."
  if sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "$CA_CERT" 2>/dev/null; then
    green "CA trusted in System Keychain"
  else
    warn "CA keychain trust skipped (may already be trusted, or user declined sudo)"
  fi
  if [[ -f "$HELPER_CA" ]]; then
    if sudo security add-trusted-cert -d -r trustRoot \
      -k /Library/Keychains/System.keychain "$HELPER_CA" 2>/dev/null; then
      green "Helper CA trusted in System Keychain"
    else
      warn "Helper CA keychain trust skipped"
    fi
  fi
fi

# ── API key ───────────────────────────────────────────────────────────────────

banner "Anthropic API Key"

CREDS_FILE="$SCI_DIR/credentials.env"

if [[ -f "$CREDS_FILE" ]] && grep -q 'ANTHROPIC_API_KEY=' "$CREDS_FILE"; then
  green "ANTHROPIC_API_KEY already set in $CREDS_FILE"
else
  printf '  Enter your Anthropic API key (sk-ant-...): '
  read -r -s API_KEY
  printf '\n'
  if [[ -n "$API_KEY" ]]; then
    mkdir -p "$SCI_DIR"
    chmod 700 "$SCI_DIR"
    if [[ -f "$CREDS_FILE" ]]; then
      # Remove any existing blank ANTHROPIC_API_KEY line and append
      grep -v '^ANTHROPIC_API_KEY=' "$CREDS_FILE" > "$CREDS_FILE.tmp" || true
      mv "$CREDS_FILE.tmp" "$CREDS_FILE"
    fi
    printf 'ANTHROPIC_API_KEY=%s\n' "$API_KEY" >> "$CREDS_FILE"
    chmod 600 "$CREDS_FILE"
    green "API key saved to $CREDS_FILE"
  else
    warn "No API key entered — skipping. Set ANTHROPIC_API_KEY in $CREDS_FILE later."
  fi
fi

# ── launchd services ──────────────────────────────────────────────────────────

banner "launchd Services"

HELPER_PLIST="$LAUNCH_AGENTS/dev.sci.helper.plist"
AGENT_PLIST="$LAUNCH_AGENTS/com.sci.agent.plist"
NODE_BIN="$(command -v node 2>/dev/null || echo "/opt/homebrew/bin/node")"

# Write dev.sci.helper.plist (Rust helper — port 3001)
# NOTE: :3001 requires SCI-239 to be fixed before this proxy is fully functional.
# The node agent (:8080) serves as fallback proxy in the interim.
write_helper_plist() {
  cat > "$HELPER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>dev.sci.helper</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BIN_DIR}/sci-helper</string>
        <string>--proxy</string><string>3001</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>RUST_LOG</key><string>info</string>
        <key>HOME</key><string>${HOME_DIR}</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${HOME_DIR}/Library/Logs/sci-helper.log</string>
    <key>StandardErrorPath</key><string>${HOME_DIR}/Library/Logs/sci-helper.log</string>
    <key>WorkingDirectory</key><string>${HOME_DIR}</string>
</dict>
</plist>
PLIST
}

# Write com.sci.agent.plist (Node agent — port 8080)
write_agent_plist() {
  cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.sci.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${BIN_DIR}/sci</string>
        <string>up</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>${HOME_DIR}</string>
        <key>SCI_CONFIG_DIR</key><string>${SCI_DIR}</string>
        <key>SCI_FASTEMBED_CACHE_DIR</key><string>${SCI_DIR}/fastembed</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${SCI_DIR}/sci.log</string>
    <key>StandardErrorPath</key><string>${SCI_DIR}/sci.log</string>
    <key>WorkingDirectory</key><string>${SCI_DIR}</string>
</dict>
</plist>
PLIST
}

mkdir -p "$LAUNCH_AGENTS"
UID_NUM="$(id -u)"

load_or_reload_service() {
  local label="$1"
  local plist="$2"
  local domain="gui/$UID_NUM"

  if launchctl list 2>/dev/null | grep -q "$label"; then
    info "Reloading $label..."
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    green "Reloaded: $label"
  else
    info "Loading $label..."
    launchctl load "$plist"
    green "Loaded: $label"
  fi
}

# Helper plist: only write/load if sci-helper binary is present
if [[ -x "$BIN_DIR/sci-helper" ]]; then
  write_helper_plist
  load_or_reload_service "dev.sci.helper" "$HELPER_PLIST"
else
  warn "sci-helper binary not found — skipping dev.sci.helper launchd service"
  warn "Install sci-helper to $BIN_DIR/sci-helper to enable the :3001 proxy"
fi

# Agent plist: always write
write_agent_plist
load_or_reload_service "com.sci.agent" "$AGENT_PLIST"

# ── MCP registration ──────────────────────────────────────────────────────────

banner "MCP Registration"

CLAUDE_JSON="$HOME_DIR/.claude.json"
MCP_ENTRY_KEY="sci"
MCP_COMMAND="node"
MCP_INDEX="$BIN_DIR/mcp/index.js"

# Read-modify-write ~/.claude.json
if [[ -f "$CLAUDE_JSON" ]]; then
  python3 - "$CLAUDE_JSON" "$MCP_ENTRY_KEY" "$MCP_COMMAND" "$MCP_INDEX" <<'PY'
import json, sys

path, key, cmd, index_js = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

with open(path) as f:
    data = json.load(f)

if "mcpServers" not in data:
    data["mcpServers"] = {}

if key in data["mcpServers"]:
    print(f"  existing '{key}' MCP entry found — updating args")
else:
    print(f"  adding '{key}' MCP entry")

data["mcpServers"][key] = {
    "type": "stdio",
    "command": cmd,
    "args": [index_js],
    "env": {
        "SCI_STORAGE_BACKEND": "sqlite",
        "SCI_LOCAL_DIR": str(__import__('pathlib').Path.home() / ".sci" / "memory"),
        "SCI_CONFIG_DIR": str(__import__('pathlib').Path.home() / ".sci"),
        "SCI_FASTEMBED_CACHE_DIR": str(__import__('pathlib').Path.home() / ".sci" / "fastembed"),
    }
}

with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
  green "MCP entry 'sci' written to $CLAUDE_JSON"
else
  # Create a minimal ~/.claude.json
  python3 - "$CLAUDE_JSON" "$MCP_INDEX" <<'PY'
import json, sys, pathlib
path, index_js = sys.argv[1], sys.argv[2]
home = str(pathlib.Path.home())
data = {
    "mcpServers": {
        "sci": {
            "type": "stdio",
            "command": "node",
            "args": [index_js],
            "env": {
                "SCI_STORAGE_BACKEND": "sqlite",
                "SCI_LOCAL_DIR": f"{home}/.sci/memory",
                "SCI_CONFIG_DIR": f"{home}/.sci",
                "SCI_FASTEMBED_CACHE_DIR": f"{home}/.sci/fastembed",
            }
        }
    }
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
  green "Created $CLAUDE_JSON with 'sci' MCP entry"
fi

# ── Proxy config (Claude Code settings) ──────────────────────────────────────

banner "Proxy Configuration"

CLAUDE_SETTINGS_DIR="$HOME_DIR/.claude"
CLAUDE_SETTINGS="$CLAUDE_SETTINGS_DIR/settings.json"
CA_BUNDLE_PATH="$CA_BUNDLE"
# Fallback to single CA cert if no bundle yet
if [[ ! -f "$CA_BUNDLE_PATH" && -f "$CA_CERT" ]]; then
  CA_BUNDLE_PATH="$CA_CERT"
fi

mkdir -p "$CLAUDE_SETTINGS_DIR"

python3 - "$CLAUDE_SETTINGS" "$CA_BUNDLE_PATH" <<'PY'
import json, sys, os

path, ca_path = sys.argv[1], sys.argv[2]

if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
else:
    data = {}

if "env" not in data:
    data["env"] = {}

# NOTE: :3001 = Rust helper (requires SCI-239 fix for full functionality).
# :8080 = Node agent (always available as fallback).
# For now we configure :3001 as the proxy target per the SCI-253 spec.
data["env"]["HTTPS_PROXY"] = "http://127.0.0.1:3001"
data["env"]["HTTP_PROXY"]  = "http://127.0.0.1:3001"
data["env"]["NODE_EXTRA_CA_CERTS"] = ca_path

with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
green "Proxy config written to $CLAUDE_SETTINGS"
info "  HTTPS_PROXY=http://127.0.0.1:3001 (SCI-239 must be fixed for full function)"
info "  NODE_EXTRA_CA_CERTS=$CA_BUNDLE_PATH"

# ── Final status check ────────────────────────────────────────────────────────

banner "Status Check"

# Give launchd a moment to start services
sleep 2

if command -v sci &>/dev/null; then
  sci status 2>/dev/null || true
else
  # sci not in PATH yet (new shell needed), run directly
  if [[ -x "$BIN_DIR/sci" ]]; then
    "$BIN_DIR/sci" status 2>/dev/null || true
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

printf '\n\033[1;32m'
printf '╔══════════════════════════════════════════╗\n'
printf '║         Sci Installation Complete        ║\n'
printf '╚══════════════════════════════════════════╝\n'
printf '\033[0m\n'

cat <<NEXT
Next steps:

  1. Open a new terminal tab (or run: source ~/.zshrc)
     to pick up the PATH change.

  2. Verify everything is healthy:
       sci status

  3. If you see proxy errors, check:
       tail -50 ~/Library/Logs/sci-helper.log
       tail -50 ~/.sci/sci.log

  4. Run a live smoke test:
       sci verify

  5. Import your Claude conversation history (optional):
       sci import --claude ~/Downloads/conversations.json

NEXT
