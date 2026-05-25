# Sci Alpha — What It Does, How It Works, What to Test

This is the content backbone for the public site. It's written to be read top-to-bottom by a new tester, then reused as page sections (What is Sci → How it works → What to test → FAQ).

---

## What Sci does

Sci is a **sovereign cognitive identity layer** for AI tools. In the alpha, that means two concrete things for Claude Code:

1. **Privacy proxy.** Every request from Claude Code passes through Sci before it reaches Anthropic. Sci replaces your real identifiers — name, email, and other PII — with stable placeholder tokens (`[PERSON_1]`, `[EMAIL_1]`), then swaps them back in the response. Anthropic never sees the real values; you never see the placeholders.

2. **Persistent memory.** Sci gives Claude Code an MCP server with four memory tools. Claude can recall facts about you, your projects, and past decisions, and store new ones — so context carries across sessions instead of starting cold every time.

The guiding principle is **sovereignty by default**: your data lives on your machine (local SQLite), and embeddings are computed locally (no per-query data sent to a third party).

---

## How it works

```
┌─────────────┐    HTTPS_PROXY=:3001    ┌──────────────┐   anonymized    ┌───────────┐
│ Claude Code │ ──────────────────────► │  sci-helper  │ ──────────────► │ Anthropic │
│  (your Mac) │ ◄────────────────────── │   (:3001)    │ ◄────────────── │           │
└─────────────┘    deanonymized reply   └──────────────┘   real reply    └───────────┘
       │                                        │
       │ MCP (memory tools)                     │ local store
       ▼                                        ▼
┌─────────────┐                         ┌──────────────┐
│ com.sci.    │                         │  SQLite +    │
│ agent :8080 │                         │  local embed │
└─────────────┘                         └──────────────┘
```

- **`dev.sci.helper`** (port 3001) — the Rust proxy. Claude Code's `HTTPS_PROXY` points here. It does the anonymize → forward → deanonymize round trip. A local CA certificate (trusted in your Keychain) lets it terminate TLS.
- **`com.sci.agent`** (port 8080) — the Node agent backing the memory store and the MCP tools.
- Both run as **launchd** services with `KeepAlive`, so they survive logout/restart.
- **Memory** is stored in local **SQLite** with locally-computed embeddings. Nothing about your memory is sent to an external embedding API.
- **MCP integration**: the installer registers `sci` in `~/.claude.json`, exposing `memory_recall`, `memory_store`, `memory_identity`, and `memory_status` to Claude Code.

---

## What to test

Work through these in order. For each, note: did it work, how long it took, and anything surprising.

### 1. Install (target: under 10 minutes, cold)
- Does the one-liner complete without manual intervention beyond the two `sudo` prompts and the API-key prompt?
- After opening a new terminal, does `sci status` print `ok: true`?
- **Report:** total time from paste to green, and any step that needed guessing.

### 2. Privacy guarantee (the core promise)
- Run `sci verify`. Does it PASS?
- In a real Claude Code session, mention your name, email, and a fake secret like `AKIA...`. Then check `~/Library/Logs/sci-helper.log` — did the real values get tokenized before leaving?
- **Try to break it:** unusual name spellings, your name mid-word, non-English text, your email in a code block.
- **Report:** anything that leaked, or any false positive (something tokenized that shouldn't have been).

### 3. Memory across sessions
- Session A (project X): "Remember that we chose SQLite over Postgres for the alpha to avoid a Docker dependency."
- Quit. Open Session B in a *different* directory: "What did we decide about the database?"
- **Report:** did B recall it? Was the recall relevant and correctly de-tokenized?

### 4. Seeding from history (optional)
- Export your Claude history (claude.ai → Settings → Privacy → Export Data), then `sci import --claude ~/Downloads/conversations.json`.
- **Report:** did `sci status` counts jump? Any import errors?

### 5. Daily-driver friction
- Use Claude Code normally for a few real tasks with Sci running.
- Do your other tools still work with the proxy active — `brew`, `git`, `npm`, `curl`?
- **Report:** anything the proxy broke, slowed, or interfered with.

### 6. Resilience
- Restart your Mac. Do the services come back automatically (`sci status` still green)?
- Rotate your API key with `sci --setup`. Does the next request use the new key?
- **Report:** anything that needed a manual kick to recover.

---

## Known issues (please don't file duplicates)

- **Intel Macs are not supported** in this alpha — Apple Silicon only.
- **First request after install can hang 30–120s** while the local embedding model downloads (~110 MB). This is expected once.
- **No auto-update.** New versions require re-running the installer.
- **Anthropic only.** Requests to other providers bypass the proxy and are not anonymized.
- **No GUI** — everything is terminal + Claude Code.

---

## FAQ

**Does my API key or data go to Casey / a Sci server?**
No. Your key lives in `~/.sci/credentials.env` on your machine. Memory is local SQLite. Sci forwards your requests straight to Anthropic with your own key.

**What does Anthropic actually receive?**
Your prompt with PII replaced by placeholder tokens. Run `sci verify` to see a real before/after.

**Can I turn it off?**
Yes — `launchctl unload ~/Library/LaunchAgents/dev.sci.helper.plist` stops the proxy. Full uninstall steps are in the install guide.

**Where are the logs?**
`~/Library/Logs/sci-helper.log` (proxy) and `~/.sci/sci.log` (agent).

**How do I report a bug?**
Include `sci status` output and recent `~/Library/Logs/sci-helper.log` lines → [GitHub Issues](https://github.com/sovereign-cognitive-identity/sci/issues) or email casey.zandbergen@gmail.com.
