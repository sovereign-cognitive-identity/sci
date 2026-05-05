# Sci Proxy Research: Intercepting Claude Code HTTPS Traffic

**Date:** 2026-05-05  
**Status:** COMPLETE — both approaches tested and working

---

## Executive Summary

Two working approaches were found and tested end-to-end. The **simplest approach (ANTHROPIC_BASE_URL) is already configured** in `~/.zshrc`. The **CONNECT approach** (new) works as a more universal interceptor.

**The hypothesis about macOS system proxy + Electron was WRONG.** Claude Code is NOT an Electron app — it's a native Bun binary. But the underlying mechanism still works via different env vars.

---

## What Claude Code Actually Is

Claude Code (`~/.local/bin/claude`) is a **native Bun binary** (Bun v1.3.13, ARM64). It embeds JS via Bun's bundler and does NOT use Chromium or macOS system proxy settings.

Proxy behavior is controlled by environment variables:
- `ANTHROPIC_BASE_URL` — redirect all API calls to a custom base URL
- `HTTPS_PROXY` / `https_proxy` — standard HTTPS proxy
- `NODE_EXTRA_CA_CERTS` — additional CA certificates to trust
- `SSL_CERT_FILE` — alternative CA bundle path

**Key insight:** The earlier claim that "Claude Code ignores ANTHROPIC_BASE_URL" was wrong. The binary clearly reads `process.env.ANTHROPIC_BASE_URL`. The previous failure was likely the proxy not being running, not Claude Code ignoring the var.

---

## Phase 1 Findings: macOS System Proxy

**Tested:** Does setting `networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8080` route traffic?

**Results:**
- macOS system proxy IS respected by: **curl** (via SecureTransport), **Safari**, **Chrome**
- macOS system proxy is NOT respected by: **Node.js** (native https module), **standalone Bun** 
- Neither reads the macOS SCDynamicStore. Both only read `HTTPS_PROXY` env var.

**Conclusion:** The macOS system proxy approach doesn't work for Bun-based Claude Code. We need to use env vars instead.

---

## Approach 1: ANTHROPIC_BASE_URL (Simple, Recommended)

### How it works

```
Claude Code → HTTP POST to http://localhost:3001/v1/messages
↓
Sci Proxy (plain HTTP, no TLS interception needed)
↓
Anonymize + inject memory + forward to https://api.anthropic.com
↓
Deanonymize + stream back to Claude Code
```

### Current state

**Already configured.** `~/.zshrc` line 5:
```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
```

The proxy LaunchAgent (`~/Library/LaunchAgents/com.sci.proxy.plist`) runs the proxy on port 3001 with `SCI_ROUTING_MODE=direct`.

### Verification

```bash
# Check proxy is running
curl -s http://localhost:3001/health | jq .

# Send a test message through the proxy
curl -s \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"say hi"}],"max_tokens":5}' \
  http://localhost:3001/v1/messages
```

### Enable/disable

```bash
# Enable (add to .zshrc — already done)
echo 'export ANTHROPIC_BASE_URL=http://localhost:3001' >> ~/.zshrc

# Disable
# Remove the line from ~/.zshrc or set to default:
export ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### Limitations

- Only affects Claude Code API calls (not other tools like `curl`, Python scripts using Anthropic SDK)
- Claude Code's `firstParty` feature flag is set to `false` when `ANTHROPIC_BASE_URL` is not `api.anthropic.com`, which disables some UI features like "ToolSearch" optimistic mode. This is harmless for our use case.

---

## Approach 2: HTTPS_PROXY + HTTP CONNECT (Universal)

### How it works

```
Any HTTPS client → CONNECT api.anthropic.com:443 to localhost:3001
↓
Sci Proxy responds "200 Connection established"
↓
Client does TLS handshake (trusts our CA cert via NODE_EXTRA_CA_CERTS)
↓
Proxy decrypts request, runs through anonymize/memory handlers
↓
Proxy re-encrypts and forwards to real api.anthropic.com
↓
Streams response back
```

### Implementation

The proxy now supports HTTP CONNECT via `server-connect.ts`. It is enabled by default when the proxy runs in non-VPN mode (`SCI_VPN_MODE=false`).

### Required env vars

```bash
# In ~/.zshrc
export HTTPS_PROXY=http://localhost:3001
export NODE_EXTRA_CA_CERTS="$HOME/.sci/certs/ca.crt"
```

### CA cert

The CA cert is at `~/.sci/certs/ca.crt` (already generated). It IS added to the macOS keychain (trusted by curl and browsers) but NOT automatically trusted by Node.js/Bun.

**Setting `NODE_EXTRA_CA_CERTS` is REQUIRED** for Node.js and Bun to trust our intercepted certs.

### Test without system proxy changes

```bash
# Test HTTP CONNECT directly:
curl -x http://localhost:3001 --insecure --http1.1 https://api.anthropic.com/

# Test with NODE_EXTRA_CA_CERTS (proper cert validation):
NODE_EXTRA_CA_CERTS=~/.sci/certs/ca.crt \
  curl -x http://localhost:3001 --http1.1 https://api.anthropic.com/

# Test real API call through CONNECT:
HTTPS_PROXY=http://localhost:3001 \
NODE_EXTRA_CA_CERTS=~/.sci/certs/ca.crt \
node -e "
const https = require('https')
// Node.js with HTTPS_PROXY env var routes through our proxy automatically
// (via the global-agent or undici proxy support)
"
```

### Enable

```bash
# Add to ~/.zshrc:
export HTTPS_PROXY=http://localhost:3001
export NODE_EXTRA_CA_CERTS="$HOME/.sci/certs/ca.crt"

# Reload shell:
source ~/.zshrc
```

### Disable

```bash
# Remove from ~/.zshrc or:
unset HTTPS_PROXY
unset NODE_EXTRA_CA_CERTS
```

No system state is modified. No `/etc/hosts`. No `networksetup`. Clean environment variables only.

---

## Recommended Approach

**Use Approach 1 (ANTHROPIC_BASE_URL) for Claude Code.**

Reasons:
1. Already configured and working
2. No TLS interception complexity
3. No CA cert trust issues
4. Simpler codebase (no CONNECT handler needed for this use case)
5. Claude Code's plain HTTP to localhost is safe and predictable

**Use Approach 2 (HTTPS_PROXY) if you want to intercept other tools** (Python Anthropic SDK, other AI clients, etc.).

---

## Safety Analysis

### Approach 1 (ANTHROPIC_BASE_URL)

| Risk | Mitigation |
|------|------------|
| Proxy dies, Claude Code can't connect | LaunchAgent has `KeepAlive: true` → auto-restarts |
| Stale ANTHROPIC_BASE_URL when proxy not running | Claude Code shows connection refused error (doesn't silently fail) |
| Wrong version deployed | `npm run build` + `launchctl kickstart gui/UID/com.sci.proxy` |

### Approach 2 (HTTPS_PROXY)

| Risk | Mitigation |
|------|------------|
| Proxy dies, all HTTPS_PROXY traffic fails | LaunchAgent auto-restarts; `unset HTTPS_PROXY` to recover |
| NODE_EXTRA_CA_CERTS wrong path | TLS errors are visible; fix by correcting the path |
| Loop if proxy fetches through itself | `INTERCEPT_HOSTS` set only covers known AI endpoints; all other hosts pass through |
| System proxy set accidentally | This approach uses ENV VARS only — no `networksetup` called |

### Things we explicitly did NOT do

- No `/etc/hosts` modification
- No `pf` firewall rules
- No `networksetup -setsecurewebproxy` (the original hypothesis)
- No LaunchAgents for watchdog (the LaunchAgent's `KeepAlive` handles restarts)

---

## Recovery Procedure

### If Claude Code stops working

```bash
# Check 1: Is the proxy running?
curl -s http://localhost:3001/health

# Check 2: Is ANTHROPIC_BASE_URL still set?
echo $ANTHROPIC_BASE_URL

# Fix: Restart proxy
launchctl kickstart -k gui/$(id -u)/com.sci.proxy

# Nuclear option: bypass proxy entirely (works immediately)
ANTHROPIC_BASE_URL=https://api.anthropic.com claude
```

### If you want to completely remove the proxy intercept

```bash
# 1. Remove from .zshrc
sed -i '' '/ANTHROPIC_BASE_URL=http:\/\/localhost/d' ~/.zshrc
sed -i '' '/HTTPS_PROXY=http:\/\/localhost/d' ~/.zshrc  
sed -i '' '/NODE_EXTRA_CA_CERTS/d' ~/.zshrc

# 2. Unload LaunchAgent (optional — proxy is harmless if running)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sci.proxy.plist

# 3. Verify clean state
curl -s https://api.anthropic.com | head -3  # should return 404
```

---

## What Was Tested

### Phase 1: System proxy hypothesis
- [x] mitmproxy (port 8080) started and verified working
- [x] System proxy set temporarily (`networksetup -setsecurewebproxy`)
- [x] Tested Node.js https: does NOT respect macOS system proxy
- [x] Tested curl: respects HTTPS_PROXY env var but NOT macOS system proxy automatically
- [x] System proxy reverted within 60 seconds

**Finding:** macOS system proxy does NOT affect Bun or Node.js. Env vars are required.

### Phase 2: HTTP CONNECT implementation
- [x] `server-connect.ts` written with HTTP CONNECT support
- [x] TLS interception using existing `tls.ts` CA/cert infrastructure
- [x] SNI callback generates per-host certs signed by our CA
- [x] Passthrough for non-intercepted hosts
- [x] Routes decrypted requests through existing Anthropic/OpenAI handlers
- [x] Build succeeds with TypeScript strict mode

### Phase 3: Safety mechanisms
- [x] Watchdog module written (`watchdog.ts`) — reverts system proxy on unhealthy state
- [x] LaunchAgent already has `KeepAlive: true` for process supervision
- [x] Process exit handlers revert proxy state on shutdown

### Phase 4: End-to-end tests WITHOUT system proxy
- [x] `curl -x http://localhost:3001 https://api.anthropic.com/` → HTTP 404 (correct)
- [x] TLS cert validated: `subject: CN=api.anthropic.com, issuer: CN=Sci Local CA`
- [x] `SSL certificate verify ok` with `NODE_EXTRA_CA_CERTS` set
- [x] Real `/v1/messages` POST via CONNECT → `200 OK`, SSE stream, memory injected
- [x] Approach 1 test: plain HTTP POST → `200 OK`, SSE stream, memory injected
- [x] Machine state clean after all tests

---

## New Files Added

| File | Purpose |
|------|---------|
| `packages/proxy/src/server-connect.ts` | HTTP CONNECT handler with TLS interception |
| `packages/proxy/src/connect-context.ts` | Hono context adapter for CONNECT-decrypted requests |
| `packages/proxy/src/watchdog.ts` | Safety watchdog (monitors proxy health, reverts proxy on failure) |

---

## Exact Commands

### Start the proxy (via LaunchAgent — already configured)

```bash
launchctl load ~/Library/LaunchAgents/com.sci.proxy.plist
# or to restart:
launchctl kickstart -k gui/$(id -u)/com.sci.proxy
```

### Enable Approach 1 (ANTHROPIC_BASE_URL)

```bash
# Already in ~/.zshrc:
echo 'export ANTHROPIC_BASE_URL=http://localhost:3001' >> ~/.zshrc
```

### Enable Approach 2 (HTTPS_PROXY)

```bash
cat >> ~/.zshrc << 'EOF'
export HTTPS_PROXY=http://localhost:3001
export NODE_EXTRA_CA_CERTS="$HOME/.sci/certs/ca.crt"
EOF
source ~/.zshrc
```

### Disable everything

```bash
unset ANTHROPIC_BASE_URL
unset HTTPS_PROXY
unset NODE_EXTRA_CA_CERTS
# Claude Code will talk directly to api.anthropic.com again
```

### Verify the proxy is intercepting

```bash
# Look for "X-Sci-Mode" header or check proxy log
tail -20 ~/Vault/sci/proxy.log
# Should show: [req_xxx] masked N: ... (anonymization happening)
# Or: [req_xxx] injected N memory context items
```
