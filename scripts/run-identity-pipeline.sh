#!/usr/bin/env bash
# Daily identity pipeline:
#   1. bootstrap-identity.py  — extract new facts from episodic memory
#   2. dedup-identity.py      — merge overlapping facts
#   3. review-stale-facts.py  — rewrite completed plans, delete abandoned ones
# Runs via LaunchAgent dev.sci.bootstrap-identity.
# Logs to ~/.sci/bootstrap-identity.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/.sci/bootstrap-identity.log"
PYTHON=/opt/homebrew/bin/python3

# Bypass the Sci HTTPS proxy for direct Anthropic API calls
export HTTPS_PROXY=""
export HOME="$HOME"

echo "" >> "$LOG_FILE"
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG_FILE"

echo "[1/3] Running bootstrap-identity.py..." >> "$LOG_FILE"
"$PYTHON" "$SCRIPT_DIR/bootstrap-identity.py" >> "$LOG_FILE" 2>&1

echo "[2/3] Running dedup-identity.py..." >> "$LOG_FILE"
"$PYTHON" "$SCRIPT_DIR/dedup-identity.py" >> "$LOG_FILE" 2>&1

echo "[3/3] Running review-stale-facts.py..." >> "$LOG_FILE"
"$PYTHON" "$SCRIPT_DIR/review-stale-facts.py" >> "$LOG_FILE" 2>&1

echo "Done." >> "$LOG_FILE"
