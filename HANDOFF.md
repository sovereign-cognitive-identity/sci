# Handoff

_Last updated: 2026-05-24 — HTTP rate limiter built and exported from core; ready for agent integration._

## Goal

Sci is a sovereign cognitive identity layer. Current focus: get to v0.1.0-alpha — a one-command install that works on a fresh Mac and routes Claude Code through the Sci proxy with memory.

## Current Progress

### This session

**HTTP Rate Limiter (token bucket, production-ready):**
- Built `packages/core/src/rate-limiter.ts` — RateLimiter class with token bucket algorithm
- Exported: `RateLimiter`, `rateLimitFetch()` wrapper, `getGlobalLimiter()` singleton
- Config via env vars: `SCI_RATE_LIMIT_RPS` (default 10), `SCI_RATE_LIMIT_BURST` (default RPS), `SCI_RATE_LIMIT_ENABLED` (default true), `SCI_LOG_RATELIMIT`
- APIs: `acquire()` (blocking), `tryAcquire()` (non-blocking), `getStatus()` (debug)
- Documentation: `docs/rate-limiting.md` with examples and full API reference
- Build: ✓ successful, types exported, ready to use
- Memory stored: rate limiter solution documented for next session

### Prior sessions
- `a8c54e05` — daily identity pipeline (dedup + stale-fact review + LaunchAgent)
- `3e771a95`, `a2dde61f`, `07185e2d` — proxy cache_control fixes (SCI-239, SCI-228)
- Identity bootstrap Phase A+B, 4 sync bugs fixed, recall content-fingerprint dedup
- SCI-253: install.sh cleanup shipped
- SCI-254: sci-status/verify shipped in `7f3a2b1d`
- identity_facts: 409 total; episodic: ~43,532

## What Worked

- **Token bucket rate limiter** — simple, non-blocking, configurable via env vars. Prevents API flooding.
- **Reusable HTTP client wrapper** — `rateLimitFetch()` can wrap any fetch implementation (node-fetch, global.fetch, agent's fetch, etc.)
- **SQLite direct deletes** for identity facts (admin API DELETE only covers episodic)
- **`env HTTPS_PROXY="" python3 script.py`** for direct Anthropic API calls
- **OAuth Bearer only** — `Authorization: Bearer <token>` + `anthropic-beta: claude-code-20250219`. No `x-api-key`.
- **Sequential curl with 0.5s sleep** for admin API POSTs (concurrent urllib → 500)
- **Iterative dedup** — run `dedup-identity.py` until "Found 0 clusters" (2–3 passes to converge)

## What Didn't Work

- **Agent's sync loop flooding API** — caused repeated calls without backoff. Fixed by: rate limiter (this session).
- **Admin API `DELETE /sci/memories/:id`** — only handles episodic; returns 404 for identity fact IDs
- **`x-api-key` header with OAuth token** — 401; OAuth mode uses only `Authorization: Bearer`
- **Admin API pagination** (`?offset=100`) — ignored; always returns same 100 rows. Use SQLite directly.
- **Concurrent urllib POSTs** — 500 from helper; use sequential curl

## Next Steps

1. **Integrate rate limiter into agent** — wrap agent's HTTP client to prevent sync loop flooding (env var: `SCI_RATE_LIMIT_RPS=5` recommended for control plane)
2. **Write unit tests for RateLimiter** — test token refill, burst capacity, blocking/non-blocking acquire
3. **Create rate-limiting example wrapper** — for admin API or other high-frequency endpoints
4. **Commit SCI-253** if not already done — `install.sh` arch naming fix
5. **Transition SCI-253 to Done** in Jira (Cloud ID: `e04b7caa-9314-439b-9772-d2bf75440183`, Done transition ID: `31`)
6. **Close SCI-249** — both sub-tickets (SCI-239 + SCI-228) shipped
7. **Verify + close SCI-223** — confirm MCP + CLI use SQLite backend, not Postgres
8. **Fix SCI-218** — CI macOS-13 runner hangs (needed for signed release tarball)
9. **Tag SCI-257** — v0.1.0-alpha GitHub Release with signed tarballs
10. **SCI-250** — tester onboarding

## Context & Gotchas

### Rate Limiting (new this session)
- **File**: `packages/core/src/rate-limiter.ts` — token bucket HTTP throttler
- **Exports**: `RateLimiter` class, `rateLimitFetch()` wrapper, `getGlobalLimiter()` singleton
- **Docs**: `docs/rate-limiting.md` — full API reference and examples
- **Config**: `SCI_RATE_LIMIT_RPS=10` (default), `SCI_RATE_LIMIT_BURST=RPS` (default), `SCI_RATE_LIMIT_ENABLED=true` (default), `SCI_LOG_RATELIMIT=false`
- **Usage**: `const limiter = new RateLimiter(); await limiter.acquire(); // then fetch`
- **For agent**: wrap with `rateLimitFetch(agentFetch, limiter)` or create instance with lower RPS (e.g., 5 for control plane)

### Services
```bash
launchctl kickstart -k "gui/$(id -u)/dev.sci.helper"   # Rust helper :3001/:3002
launchctl kickstart -k "gui/$(id -u)/com.sci.agent"    # Node agent :8080
launchctl start dev.sci.bootstrap-identity              # trigger daily pipeline manually
tail -f ~/.sci/bootstrap-identity.log                   # watch pipeline
```

### Storage
- **identity_facts**: 409 rows, no embeddings (`embeddings_identity` empty)
- **episodic_memories**: ~43,532 rows
- **SQLite**: `~/.sci/memory/sci.db`

### Codebase conventions
- `packages/cli/` — `@sci/cli`. SCI-254 subcommands (`status`, `verify`) live here.
- `packages/mcp/src/` — TypeScript; `npm run build` after edits. `dist/` is gitignored.
- `packages/core/dist/` + `packages/proxy/dist/` + `packages/agent/dist/` — **tracked** (compiled output committed).
- Rust helper: `cargo build --release` from `apps/sci-mac/SciHelper/` (~30s), then kickstart.
- CI tarball format: `sci-{aarch64-apple-darwin,x86_64-apple-darwin}.tar.gz` — no `sci-helper` in tarball (it's a separate native binary)

### Admin API (`:3002`)
`GET /sci/status` · `GET /sci/recall?query=&limit=` · `GET /sci/identity?query=&category=&limit=` · `POST /sci/memories` · `DELETE /sci/memories/:id` (episodic only)

### Auth
- **OAuth token**: `~/.sci/oauth.json` → `access_token`. Bearer auth only.
- **Console key** (`~/.sci/console-key.env`): no credits — don't use.
- **Agent token**: `~/.sci/agent.token` — control plane (`control.sci.sh`) auth.

### Jira
- Cloud ID: `e04b7caa-9314-439b-9772-d2bf75440183`
- Done transition ID: `31`
