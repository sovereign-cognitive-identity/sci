#!/usr/bin/env bash
# Sci Proxy — Smoke Tests
#
# Quick sanity checks against a running proxy instance.
# Sends real HTTPS requests through the proxy and verifies connectivity.
#
# Usage:
#   ./scripts/test-proxy-smoke.sh
#   npm run test:smoke
#
# Prerequisites:
#   - sci proxy running on port 8080 (npm run proxy or launchd agent)
#   - ~/.sci/ca.crt in place
#   - ~/.sci/oauth.json with valid access_token

set -euo pipefail

PROXY_PORT="${SCI_PROXY_PORT:-8080}"
CA_CERT="${HOME}/.sci/ca.crt"
OAUTH_FILE="${HOME}/.sci/oauth.json"
SCI_LOG="${HOME}/.sci/sci.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass_count=0
fail_count=0

pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  pass_count=$((pass_count + 1))
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  if [[ -n "${2:-}" ]]; then
    echo -e "    ${YELLOW}→${NC} $2"
  fi
  fail_count=$((fail_count + 1))
}

echo ""
echo "── Sci Proxy Smoke Tests"
echo "   Proxy port: ${PROXY_PORT}"
echo ""

# ── Check 1: Proxy is listening on port ──────────────────────────────────────

echo "── 1. Proxy connectivity"

HTTP_CODE=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "http://localhost:${PROXY_PORT}/" 2>/dev/null || echo "000")
if [[ "${HTTP_CODE}" == "000" ]]; then
  fail "Proxy not responding on :${PROXY_PORT}" "Is the sci agent running? Check: ps aux | grep sci"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  PROXY_BODY=$(curl -s --max-time 3 "http://localhost:${PROXY_PORT}/" 2>/dev/null || echo "")
  if echo "${PROXY_BODY}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'status' in d or 'name' in d" 2>/dev/null; then
    pass "Proxy responding on :${PROXY_PORT} (health OK)"
  else
    pass "Proxy listening on :${PROXY_PORT} (HTTP 200)"
  fi
elif [[ "${HTTP_CODE}" == "405" || "${HTTP_CODE}" == "400" ]]; then
  # CONNECT-only proxy — 405/400 on plain GET is expected, proxy is functional
  pass "Proxy listening on :${PROXY_PORT} (CONNECT-mode, HTTP ${HTTP_CODE} on GET is expected)"
else
  pass "Proxy listening on :${PROXY_PORT} (HTTP ${HTTP_CODE})"
fi

# ── Check 2: Health endpoint ──────────────────────────────────────────────────

HEALTH_RESP=$(curl -s --max-time 3 "http://localhost:${PROXY_PORT}/health" 2>/dev/null || echo "")
if echo "${HEALTH_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok') == True" 2>/dev/null; then
  BACKEND=$(echo "${HEALTH_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('backend','unknown'))" 2>/dev/null)
  pass "Health check OK (backend: ${BACKEND})"
else
  # Agent-mode CONNECT proxy may return a plain-text info message or nothing — that's OK
  if [[ -z "${HEALTH_RESP}" ]]; then
    echo -e "  ${YELLOW}~${NC} /health not available (agent-mode proxy — skipping)"
  else
    echo -e "  ${YELLOW}~${NC} /health returned non-JSON (agent-mode CONNECT proxy — skipping)"
  fi
fi

# ── Check 3: CA cert exists ───────────────────────────────────────────────────

echo ""
echo "── 2. TLS / CA certificate"

if [[ -f "${CA_CERT}" ]]; then
  CA_SUBJECT=$(openssl x509 -noout -subject -in "${CA_CERT}" 2>/dev/null | head -1 || echo "")
  pass "CA cert exists at ~/.sci/ca.crt (${CA_SUBJECT})"
else
  fail "CA cert missing at ${CA_CERT}" "Run: sci install or check installation"
fi

# ── Check 4: Send HTTPS request through proxy to api.anthropic.com ───────────

echo ""
echo "── 3. HTTPS request through proxy → api.anthropic.com"

if [[ ! -f "${OAUTH_FILE}" ]]; then
  fail "OAuth token missing at ${OAUTH_FILE}" "Cannot make authenticated request"
else
  ACCESS_TOKEN=$(python3 -c "import json; d=json.load(open('${OAUTH_FILE}')); print(d.get('access_token',''))" 2>/dev/null || echo "")

  if [[ -z "${ACCESS_TOKEN}" ]]; then
    fail "Could not read access_token from ${OAUTH_FILE}"
  else
    # Send models list request through proxy — low cost, no token generation
    if [[ -f "${CA_CERT}" ]]; then
      MODELS_RESP=$(HTTPS_PROXY="http://localhost:${PROXY_PORT}" \
        NODE_EXTRA_CA_CERTS="${CA_CERT}" \
        curl -s --max-time 10 \
          --proxy "http://localhost:${PROXY_PORT}" \
          --cacert "${CA_CERT}" \
          "https://api.anthropic.com/v1/models" \
          -H "authorization: Bearer ${ACCESS_TOKEN}" \
          -H "anthropic-version: 2023-06-01" \
          -H "anthropic-beta: oauth-2025-04-20" \
          2>&1 || echo "CURL_FAILED")
    else
      MODELS_RESP=$(curl -s --max-time 10 \
        "https://api.anthropic.com/v1/models" \
        -H "authorization: Bearer ${ACCESS_TOKEN}" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: oauth-2025-04-20" \
        2>&1 || echo "CURL_FAILED")
    fi

    if echo "${MODELS_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'data' in d or 'models' in d or d.get('type') == 'list'" 2>/dev/null; then
      MODEL_COUNT=$(echo "${MODELS_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data', d.get('models', []))))" 2>/dev/null || echo "?")
      pass "HTTPS request through proxy succeeded (${MODEL_COUNT} models returned)"
    elif echo "${MODELS_RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin)" 2>/dev/null; then
      # Valid JSON but unexpected shape
      fail "HTTPS request returned unexpected JSON" "$(echo "${MODELS_RESP}" | head -c 200)"
    else
      fail "HTTPS request through proxy failed" "${MODELS_RESP:0:200}"
    fi
  fi
fi

# ── Check 5: Raw Anthropic connectivity (bypassing proxy, as baseline) ────────

echo ""
echo "── 4. Direct Anthropic connectivity (baseline)"

DIRECT_RESP=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
  "https://api.anthropic.com/v1/models" \
  -H "anthropic-version: 2023-06-01" \
  2>/dev/null || echo "000")

if [[ "${DIRECT_RESP}" == "200" || "${DIRECT_RESP}" == "401" ]]; then
  pass "Direct connectivity to api.anthropic.com (HTTP ${DIRECT_RESP})"
elif [[ "${DIRECT_RESP}" == "000" ]]; then
  fail "Cannot reach api.anthropic.com directly" "Network issue or DNS misconfiguration"
else
  fail "Unexpected HTTP ${DIRECT_RESP} from api.anthropic.com"
fi

# ── Check 6: sci.log has recent activity ─────────────────────────────────────

echo ""
echo "── 5. Log activity"

if [[ ! -f "${SCI_LOG}" ]]; then
  fail "sci.log not found at ${SCI_LOG}" "Is the sci agent running?"
else
  # Get mtime of log in epoch seconds
  if [[ "$(uname)" == "Darwin" ]]; then
    LOG_MTIME=$(stat -f '%m' "${SCI_LOG}" 2>/dev/null || echo "0")
  else
    LOG_MTIME=$(stat -c '%Y' "${SCI_LOG}" 2>/dev/null || echo "0")
  fi
  NOW=$(date +%s)
  LOG_AGE=$((NOW - LOG_MTIME))

  if [[ "${LOG_AGE}" -le 300 ]]; then
    # Log modified within 5 minutes — check for proxy-level activity
    LAST_LINE=$(tail -1 "${SCI_LOG}" 2>/dev/null || echo "")
    pass "sci.log recently modified (${LOG_AGE}s ago)"
    if [[ -n "${LAST_LINE}" ]]; then
      echo -e "    ${YELLOW}→${NC} last entry: ${LAST_LINE:0:100}"
    fi
  else
    fail "sci.log last modified ${LOG_AGE}s ago (expected < 300s)" \
      "Start the sci agent: launchctl start com.sci.agent"
  fi

  # Check for error patterns in recent lines (grep -c exits 1 on 0 matches — suppress)
  RECENT_ERRORS=$(tail -50 "${SCI_LOG}" | grep -c 'ERROR\|FATAL\|panic\|Uncaught' 2>/dev/null; true)
  RECENT_ERRORS="${RECENT_ERRORS:-0}"
  if [[ "${RECENT_ERRORS}" -gt 0 ]]; then
    fail "Found ${RECENT_ERRORS} error(s) in last 50 log lines" \
      "Run: tail -50 ~/.sci/sci.log | grep -E 'ERROR|FATAL'"
  else
    pass "No errors in recent log entries"
  fi
fi

# ── Check 7: OAuth token is valid (not expired) ───────────────────────────────

echo ""
echo "── 6. OAuth token validity"

if [[ -f "${OAUTH_FILE}" ]]; then
  EXPIRES_AT=$(python3 -c "
import json, sys
d = json.load(open('${OAUTH_FILE}'))
exp = d.get('expires_at_ms', 0)
print(exp)
" 2>/dev/null || echo "0")

  NOW_MS=$(python3 -c "import time; print(int(time.time() * 1000))" 2>/dev/null || echo "0")

  if [[ "${EXPIRES_AT}" -gt "${NOW_MS}" ]]; then
    # How many hours until expiry
    HOURS_LEFT=$(python3 -c "print(round((${EXPIRES_AT} - ${NOW_MS}) / 3600000, 1))" 2>/dev/null || echo "?")
    pass "OAuth token valid (expires in ${HOURS_LEFT}h)"
  elif [[ "${EXPIRES_AT}" -eq "0" ]]; then
    fail "expires_at_ms is 0 — token was force-reset" "Run: node scripts/reset-proxy-rate-limit.mjs to refresh"
  else
    AGO_S=$(python3 -c "print(round((${NOW_MS} - ${EXPIRES_AT}) / 1000))" 2>/dev/null || echo "?")
    fail "OAuth token expired ${AGO_S}s ago" "Sci should auto-refresh — check sci.log for refresh errors"
  fi
else
  fail "No oauth.json found" "Run sci auth flow to obtain a token"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "$(printf '%0.s─' {1..50})"
TOTAL=$((pass_count + fail_count))
echo "  ${pass_count}/${TOTAL} checks passed"
echo ""

if [[ "${fail_count}" -gt 0 ]]; then
  echo -e "  ${RED}OVERALL: FAIL${NC}"
  exit 1
else
  echo -e "  ${GREEN}OVERALL: PASS${NC}"
fi
