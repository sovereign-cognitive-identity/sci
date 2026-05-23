#!/bin/bash
# Diagnostic: isolate whether anonymization, memory, both, or neither triggers
# the proxy-mode 429s. Fires 5 rapid /v1/messages through the proxy in each of
# 4 modes, with a 70s recovery between modes so the sliding-minute window resets.
#
# Requires: ~/.claude/.credentials.json or keychain (CC bearer), running sci-agent.

set -uo pipefail

PLIST=~/Library/LaunchAgents/com.sci.agent.plist
PLIST_BAK=/tmp/com.sci.agent.plist.bak.$$
PROXY=http://localhost:8080
CA=$HOME/.sci/ca.crt
LOG=$HOME/.sci/sci.log

# CC's bearer from keychain
BEARER=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')
if [[ -z "${BEARER}" || "${BEARER}" != sk-ant-oat01-* ]]; then
  echo "✗ Could not extract CC bearer from keychain (got prefix: ${BEARER:0:15})" >&2
  exit 1
fi
echo "✓ Got CC bearer ($(echo -n "$BEARER" | wc -c) bytes, starts ${BEARER:0:20}…)"

# Backup plist, restore on exit
cp "$PLIST" "$PLIST_BAK"
trap 'cp "$PLIST_BAK" "$PLIST"; launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST" 2>/dev/null; rm -f "$PLIST_BAK"; echo "↶ plist restored, agent reloaded"' EXIT

# Realistic-ish payload: medium-length system + a couple turns + a fresh question.
# Targets ~3-4k input tokens per request (well under any cap, but enough to
# matter when fired in burst). Streaming response so we see the first chunk.
BODY=$(cat <<'JSON'
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 200,
  "stream": true,
  "system": "You are a helpful assistant testing rate limits. Keep responses to one short sentence. The user is debugging a proxy. Background context follows for token budget realism: the user is the builder of a sovereign cognitive identity layer. The system is composed of several TypeScript packages including a core memory store backed by SQLite and HNSW, an MCP server exposing memory_recall/memory_store/memory_identity, a CLI for status and import, and a local HTTPS proxy that anonymizes prompts and injects memory context before forwarding to upstream model providers. The proxy supports Anthropic, OpenAI, and Google formats. Anonymization swaps detected entities (people, emails, places, projects, URLs, handles) for typed placeholder tokens like [PERSON_1], and deanonymizes the response stream on the way back. Memory injection recalls semantically-similar prior user statements, masks them with the same session token map, and prepends them as a system message. The whole pipeline runs locally as a launchd-managed Node process listening on localhost:8080.",
  "messages": [
    {"role": "user", "content": "What's 2+2? Just the number."},
    {"role": "assistant", "content": "4"},
    {"role": "user", "content": "Now what's the capital of France? One word."}
  ]
}
JSON
)

# Fire one /v1/messages?beta=true through the proxy, capture status from response.
fire() {
  local n=$1
  local ms=$(date +%s%N | cut -c1-13)
  local raw
  raw=$(curl -sS --max-time 30 \
    --cacert "$CA" \
    --proxy "$PROXY" \
    -H "Authorization: Bearer $BEARER" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Content-Type: application/json" \
    -H "x-app: cli" \
    -H "User-Agent: claude-cli/2.1.150 (external, cli)" \
    -d "$BODY" \
    "https://api.anthropic.com/v1/messages?beta=true" 2>&1 | head -c 200)
  local me=$(date +%s%N | cut -c1-13)
  local dur=$((me - ms))
  if echo "$raw" | grep -q '"type":"error"'; then
    local etype=$(echo "$raw" | sed -n 's/.*"type":"\([a-z_]*_error\)".*/\1/p')
    printf "  [%d] %5dms ✗ %s\n" "$n" "$dur" "$etype"
    return 1
  elif echo "$raw" | grep -qE '(event: message_start|event: sci\.anonymized)'; then
    printf "  [%d] %5dms ✓\n" "$n" "$dur"
    return 0
  else
    printf "  [%d] %5dms ? %s\n" "$n" "$dur" "$(echo "$raw" | head -c 80 | tr '\n' ' ')"
    return 2
  fi
}

# Rewrite the plist with the given env-var settings (anon=on/off, mem=on/off),
# unload+load, wait for agent ready.
set_mode() {
  local anon_off=$1   # 1 or 0
  local mem_off=$2    # 1 or 0
  python3 - "$PLIST" "$anon_off" "$mem_off" <<'PY'
import plistlib, sys
p, anon_off, mem_off = sys.argv[1], sys.argv[2], sys.argv[3]
with open(p, 'rb') as f: d = plistlib.load(f)
env = d.setdefault('EnvironmentVariables', {})
for k in ('SCI_DISABLE_ANON', 'SCI_DISABLE_MEMORY'):
    env.pop(k, None)
if anon_off == '1': env['SCI_DISABLE_ANON'] = '1'
if mem_off  == '1': env['SCI_DISABLE_MEMORY'] = '1'
with open(p, 'wb') as f: plistlib.dump(d, f)
PY
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load   "$PLIST" 2>/dev/null
  # Wait for "listening" line in fresh log section
  local i=0
  while ! tail -20 "$LOG" 2>/dev/null | grep -q "listening on http://localhost:8080"; do
    sleep 0.3
    i=$((i+1))
    [[ $i -gt 30 ]] && { echo "  ✗ agent did not become ready in 9s"; return 1; }
  done
  sleep 0.5
}

run_mode() {
  local label=$1 anon_off=$2 mem_off=$3
  echo
  echo "━━━ $label  (anon_off=$anon_off  mem_off=$mem_off) ━━━"
  set_mode "$anon_off" "$mem_off"
  local ok=0 fail=0 other=0
  for i in 1 2 3 4 5; do
    if fire "$i"; then ok=$((ok+1)); else
      rc=$?
      if [[ $rc -eq 1 ]]; then fail=$((fail+1)); else other=$((other+1)); fi
    fi
    sleep 0.4   # ~rapid-fire (close to what CC does in burst)
  done
  echo "  → result: ${ok}/5 ok, ${fail}/5 error, ${other}/5 other"
}

echo
echo "Testing 4 modes × 5 rapid requests, 70s recovery between modes."
echo "(Total runtime ~5 min)"

run_mode "MODE 1: baseline (anon ON, memory ON)"  0 0
echo "  ...waiting 70s for rate-limit window to clear..."
sleep 70

run_mode "MODE 2: anon ON, memory OFF"            0 1
echo "  ...waiting 70s for rate-limit window to clear..."
sleep 70

run_mode "MODE 3: anon OFF, memory ON"            1 0
echo "  ...waiting 70s for rate-limit window to clear..."
sleep 70

run_mode "MODE 4: both OFF (pure passthrough)"    1 1

echo
echo "Done. Higher ok counts in some modes vs others ⇒ that's our signal."
