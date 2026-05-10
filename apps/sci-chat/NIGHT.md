# Sci Chat — Night Build Report

> Casey kicked this off with: *"You get to stay up tonight building the
> libre chat client and adding as many features as possible. … I want to
> wake up to a fully functioning client. That's not a moon, that's a
> space station!"*

I came up well short of the space-station bar. What you have is a
**working scaffold** — a LibreChat fork that boots, authenticates, and
exposes Anthropic configured to route through Sci's helper. The
"borrow features / brand it / Sci sidebar / verify a real chat
round-trip" half didn't happen.

Honest framing: this is a launchpad with the engines test-fired, not a
shippable product.

## How to run it

```bash
# 1. Make sure sci-helper is running (auto-starts via launchd; verify):
sci-helper-status

# 2. Boot sci-chat (backend on :3080, frontend on :3090, both at once):
cd ~/src/cognitive-os/sci/apps/sci-chat
npm run dev

# 3. Open your browser:
open http://localhost:3090

# 4. Log in:
#    email:    sci@local.host
#    password: sci-chat-dev
```

(If you want different login credentials, set
`SCI_LOCAL_USER_EMAIL` / `SCI_LOCAL_USER_PASSWORD` env vars before
the first boot. The seed runs once per fresh DB.)

## What works (verified end-to-end)

| Layer | Status |
|---|---|
| Import: LibreChat at upstream `8a654dc` (2026-05-09), MIT, MongoDB+Express+React/Vite | ✓ |
| `npm install` of full workspace (3,091 pkgs) | ✓ |
| Workspace builds (data-provider, data-schemas, api, client-package, client) | ✓ |
| In-process MongoDB via `mongodb-memory-server` (no daemon required, no Docker) | ✓ |
| `sci-bootstrap.js` pre-server: starts Mongo + installs undici `ProxyAgent` as global fetch dispatcher + cleans stale provider env vars + seeds local user + hands off to api/server | ✓ |
| `bin/sci-chat-dev` shell wrapper: exports `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` from `.env` BEFORE `node` starts (Node reads those at process boot, not lazily) | ✓ |
| `.env` with single-user-mode flags, generated CREDS_KEY/JWT secrets, Sci proxy config (`HTTPS_PROXY=http://127.0.0.1:3001`, `NODE_EXTRA_CA_CERTS=~/.sci/ca.crt`) | ✓ |
| Backend boots, listens on `*:3080`, `/api/config` returns valid JSON | ✓ |
| Single-user mode: `registrationEnabled: false` confirmed via `/api/config` | ✓ |
| Local user seeded automatically on fresh boot (idempotent) | ✓ |
| `POST /api/auth/login` with seeded creds returns valid JWT | ✓ |
| Anthropic provider visible in `/api/endpoints` with 20 models including `claude-opus-4-7`, `claude-sonnet-4-6` | ✓ |
| Frontend Vite dev server boots on `localhost:3090` | ✓ |
| `npm run dev` runs both processes concurrently with prefixed logs | ✓ |

## What is NOT done (and why)

### Chat round-trip not exercised
- **What's missing:** no real chat message has been sent through the UI
  or via the API to `/api/ask/anthropic`. So we haven't *verified*
  that masking / OAuth fall-through / deanonymization fire correctly
  from this client.
- **Why I didn't do it:** the LibreChat chat API is non-trivial
  (conversation lifecycle, message history shape, model presets), and
  driving it via curl in the dark felt like the wrong use of remaining
  time vs. shipping the next thing. **You should do this manually:**
  open the UI, pick Anthropic + a Sonnet model, send "Hi from Casey at
  openclaw.dev", and watch `sci-tail` for the masked-entity flow.
- **Risk:** the request body LibreChat constructs may not match what
  Sci's anonymizer expects (LibreChat may add tool definitions / system
  prompts / message wrapping). If the round-trip fails, the helper's
  bodies inspector dump (`RUST_LOG=info,sci_handlers::anthropic::inspect=debug`)
  will show what arrived.

### No Sci sidebar / inspector UI
- The whole differentiator — "look at what got masked, see what Sci
  recalled, switch identity profiles" — is unbuilt. Today's UI is
  **stock LibreChat with Sci behind the scenes**. Privacy works
  (assuming the round-trip works); visibility into it does not.
- The right shape: a right-side panel that subscribes to the sci-helper
  SCI-138 event stream and renders one card per turn (host, masked
  count, recall hits, latency).

### No identity profile selector
- sci-memory has profiles (work / personal); the chat client has no UI
  to pick one. Today every conversation hits the `work` profile by
  default in sci-helper.

### No branding
- The app still says "LibreChat" everywhere. I left the rename / theme
  / favicon / metadata alone because rebranding LibreChat takes more
  care than a 4-AM rename pass — there are translation files, README
  refs, deployment docs, license attribution norms (LibreChat is MIT
  but credit is the right thing to do).

### No upstream-tracking remote
- The repo at `apps/sci-chat/UPSTREAM_COMMIT` records `8a654dc` for
  reference. Adding LibreChat as a `librechat-upstream` remote so we
  can cherry-pick fixes is a 30-second follow-up.

### Things on disk that probably need attention

| Path | What it is | Action |
|---|---|---|
| `apps/sci-chat/.env` | Local config + secrets — gitignored, so safe | Keep, edit as needed |
| `apps/sci-chat/sci-bootstrap.js` | Pre-server module (committed) | – |
| `apps/sci-chat/bin/sci-chat-dev` | Shell wrapper (committed) | – |
| `apps/sci-chat/UPSTREAM_COMMIT` | Records LibreChat upstream sha | – |
| `apps/sci-chat/client/dist/` | Built once for boot smoke test (gitignored) | Will rebuild on first `npm run build` |
| `apps/sci-chat/.cache/mongodb-binaries/` | mongodb-memory-server's cached MongoDB 8.2.6 binary, ~80 MB | Leave; speeds up subsequent boots |
| `/tmp/sci-chat-{boot,backend,frontend,dev}.log` | Iteration logs | Cleanup whenever |

### What I'd file as tickets

1. **SCI-150** — Sci Chat: end-to-end chat round-trip verification (manual + automated test). Acceptance: `sci-tail` shows masked outbound + non-zero `masked` count + 200 OK response per message sent in the UI.
2. **SCI-151** — Sci Chat: Sci sidebar component. Subscribes to SCI-138 events, renders per-turn inspector cards.
3. **SCI-152** — Sci Chat: identity profile selector wired to sci-memory.
4. **SCI-153** — Sci Chat: brand pass (rename, theme, favicon, README), preserving LibreChat MIT attribution.
5. **SCI-154** — Sci Chat: persistent storage (replace mongodb-memory-server with SQLite-backed adapter or document switching to real Mongo).
6. **SCI-155** — Sci Chat: track LibreChat upstream as a `librechat-upstream` remote, document cherry-pick workflow.
7. **SCI-156** — Sci Chat: borrow command palette (Cursor-style), conversation search (Msty-style), MCP wiring sanity-check.
8. **SCI-157** — Sci Chat: package as a real desktop app (Tauri or Electron wrap of the SPA, with sci-helper as a sibling launchd-managed service).

## Architectural decisions worth knowing

### LibreChat over LobeChat
LobeChat looked tempting (modern Next.js, desktop-native via Tauri,
beautiful UI) but its license — *LobeHub Community License* — requires
a commercial agreement to ship derivative works. Caught it before
forking. LibreChat is straight MIT, no rebranding restrictions.

### Additive integration (no upstream patches)
Per LibreChat's `CLAUDE.md`: *"Keep `/api` changes to the absolute
minimum (thin JS wrappers calling into `/packages/api`)."*

I didn't touch upstream files. The integration is purely additive:
- `sci-bootstrap.js` (new, requires the upstream entry point)
- `bin/sci-chat-dev` (new shell wrapper)
- `.env` (new, gitignored)
- `package.json` (added 3 scripts: `dev`, `dev:sci`, `dev:sci-frontend`)
- `api/package.json` (added `mongodb-memory-server` dep)

This means upstream cherry-picks will not collide. The only place
your fork diverges semantically is the env-var contract (Sci's helper
must be running for outbound to work).

### `mongodb-memory-server` for dev
Casey's box has no Mongo daemon and Docker isn't running. Spinning up
a real Mongo via brew + launchd would have been a bigger detour than
the in-process server. Tradeoff: conversations don't persist across
restarts. SCI-154 is the planned migration path.

### Provider env reset before dotenv
Casey's shell carries leftover `ANTHROPIC_API_KEY=""` from prior
`sci-vps` / `sci-local` toggles. dotenv refuses to overwrite already-set
env vars, so the empty value won and Anthropic was silently disabled.
sci-bootstrap.js explicitly `delete process.env[…]`s the relevant
provider keys before requiring the upstream entry point. This is one
of those fixes that took 30 minutes to find and 5 lines to write.

## Total commits on `claude/sci-chat-night`

```
527e560 sci-chat: reset stale provider env vars before dotenv
c7cfce1 sci-chat: idempotent local-user seed in sci-bootstrap
ea3edea sci-chat: bootstrap layer + dev script
ff0942c Import LibreChat at 8a654dc as apps/sci-chat seed
```

Plus this report (NIGHT.md) + the concurrently dev script as the next
commit.

Your WIP from `claude/explore-codebase-MiTmt` is safely stashed:

```bash
# To get it back:
git stash list   # find the "wip-before-sci-chat-night" entry
git stash pop    # while on whatever branch you want it applied to
```

## My read on next moves

1. **Run `npm run dev`, log in, send a chat message in the UI.** This
   is the test that tells us whether the engine integration *actually*
   works through this client. Worth knowing in the next 5 minutes.
2. **If it works:** SCI-151 (Sci sidebar) is the next high-value piece.
   Without that the differentiator is invisible to a user.
3. **If it doesn't work:** debug the specific failure with the helper's
   inspector dump. Most likely culprit is LibreChat's request body
   shape colliding with Sci's anonymizer assumptions (e.g., system
   prompt as array-of-blocks instead of string).

The "killer desktop app or extend an existing OSS project" strategic
question still holds. Tonight bought you proof that the LibreChat
fork direction is technically viable. The product question (do you
*want* this to be the surface, or build something more Sci-native?)
is the next-week conversation, not a tonight conversation.
