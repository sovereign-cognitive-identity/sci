#!/usr/bin/env bash
# sci-up.sh — verify the local Sci stack is healthy. SQLite-only: no Docker,
# no Postgres. The two proxies are launchd KeepAlive services, so this mostly
# checks + kickstarts them and runs one live smoke test.
#
# Checks:
#   1. dev.sci.helper listening on :3001 (primary proxy; kickstart if down)
#   2. com.sci.agent  listening on :8080 (node agent; kickstart if down)
#   3. ~/.sci/ca.crt present
#   4. ~/.sci/memory/sci.db present + readable (the shared SQLite store)
#   5. ~/.sci/oauth.json has a non-expired access_token
#   6. one live /v1/messages (Haiku) through :3001 returns a stream, not an error
#
# Exit 0 = all green. Exit 1 = something needs attention.

UID_NUM="$(id -u)"
CA="$HOME/.sci/ca.crt"
DB="$HOME/.sci/memory/sci.db"
OAUTH="$HOME/.sci/oauth.json"
fail=0
green() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
red()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn()  { printf '  \033[33m⚠\033[0m %s\n' "$1"; }

check_proxy() {
  local label="$1" job="$2" port="$3"
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    green "$label listening on :$port"
    return
  fi
  warn "$label not on :$port — kickstarting $job"
  launchctl kickstart -k "gui/$UID_NUM/$job" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    nc -z 127.0.0.1 "$port" 2>/dev/null && { green "$label came up on :$port"; return; }
  done
  red "$label still not listening on :$port (check ~/Library/Logs or ~/.sci/sci.log)"
}

echo "── sci stack health ──"
# Primary proxy = 8080 node agent (works with the current ~/.sci/ca.crt + has
# the SCI-147 fix). The 3001 Rust helper is OPTIONAL and currently expected
# down: it can't parse the PKCS#1 ca.key the node agent writes (SCI-231). We
# report its status but don't auto-revive it (that would just crash-loop).
check_proxy "agent (com.sci.agent)" "com.sci.agent" 8080
if nc -z 127.0.0.1 3001 2>/dev/null; then
  green "helper (dev.sci.helper) listening on :3001"
else
  warn "helper (dev.sci.helper) down on :3001 — known, blocked on SCI-231 (CA key format). 8080 is the active proxy."
fi

[[ -f "$CA" ]] && green "CA cert present ($CA)" || red "CA cert missing ($CA)"

if [[ -r "$DB" ]]; then
  green "SQLite store readable ($(du -h "$DB" | cut -f1))"
else
  red "SQLite store missing/unreadable ($DB)"
fi

# OAuth access token presence + expiry
if [[ -f "$OAUTH" ]]; then
  python3 - "$OAUTH" <<'PY'
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))
    tok = d.get("access_token", "")
    exp = d.get("expires_at_ms")
    if not tok:
        print("RED no access_token in oauth.json"); sys.exit(0)
    if exp and exp < time.time()*1000:
        print("RED access_token expired (re-auth: node packages/ui/dist/oauth-cli.js login)"); sys.exit(0)
    mins = int((exp/1000 - time.time())/60) if exp else None
    print(f"GREEN OAuth access_token present" + (f" (~{mins}m left)" if mins is not None else ""))
except Exception as e:
    print(f"RED oauth.json unreadable: {e}")
PY
fi | while read -r status msg; do
  [[ "$status" == GREEN ]] && green "$msg" || red "$msg"
done

# Live smoke test: Haiku through :8080. No auth header → the agent injects sci's
# OAuth from ~/.sci/oauth.json, exercising the full inject+forward path. Haiku is
# the safe probe (premium models are OAuth-shape-gated + rate-limited).
if nc -z 127.0.0.1 8080 2>/dev/null; then
  body='{"model":"claude-haiku-4-5-20251001","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"reply OK"}]}'
  resp="$(curl -sS --cacert "$CA" --max-time 25 --proxy http://127.0.0.1:8080 \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" -d "$body" \
    "https://api.anthropic.com/v1/messages?beta=true" 2>&1 | head -c 200)"
  if echo "$resp" | grep -q 'message_start\|sci.anonymized'; then
    green "live /v1/messages (haiku) through :8080 streamed OK"
  elif echo "$resp" | grep -q '"type":"error"'; then
    red "smoke test error: $(echo "$resp" | sed -n 's/.*\"type\":\"\([a-z_]*_error\)\".*/\1/p')"
  else
    red "smoke test unexpected: ${resp:0:80}"
  fi
fi

echo "──────────────────────"
if [[ "$fail" == 0 ]]; then
  printf '\033[32msci stack: OK\033[0m\n'; exit 0
else
  printf '\033[31msci stack: needs attention (see ✗ above)\033[0m\n'; exit 1
fi
