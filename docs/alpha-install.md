# Sci Alpha — Install Guide

> Alpha v0.1.0 · macOS · Invite only

## What you're getting

Sci is a local proxy that sits between Claude Code and Anthropic. Before any request leaves your machine, it substitutes your real name, email, and other PII with stable placeholder tokens, then restores them in the response. It also injects relevant memory context — facts about you, your projects, and past decisions — into every session via an MCP server connected to a local Postgres + pgvector store. The alpha proves the core pipeline: anonymization, memory injection, and deanonymization all working end-to-end with Claude Code. What's not included yet: auto-update, a GUI, multi-provider routing, and cloud storage sync.

---

## Prerequisites

- macOS 13 or later (Apple Silicon recommended; Intel supported)
- Claude Code installed and working (`claude --version` should succeed)
- Anthropic API key (`sk-ant-...`)
- Docker Desktop running
- An invite token (provided by Casey)

---

## Install

```bash
SCI_TOKEN=<your-token> curl -fsSL https://sci.sh/install | sh
```

Without a token (if you're on the open list):

```bash
curl -fsSL https://sci.sh/install | sh
```

> **Note:** The install URL is a placeholder — the real URL will be in your invite email. The installer requires `sudo` for two steps: trusting the CA certificate and writing to `/usr/local/bin`.

The installer will:

1. Detect your architecture (Apple Silicon or Intel) and download the matching binary
2. Install `sci` to `/usr/local/bin/` (or `~/.sci/bin/` if you decline sudo)
3. Generate a local CA certificate and trust it in your macOS Keychain
4. Start Postgres via Docker Compose and apply the schema
5. Register the `sci` MCP server with Claude Code (`claude mcp add`)
6. Write `HTTPS_PROXY` and `ANTHROPIC_BASE_URL` to your `~/.zshrc`
7. Prompt for your Anthropic API key and write it to `~/.sci/credentials.env`

---

## First-run setup

After the installer finishes, run the setup wizard:

```bash
sci setup
```

This verifies the database connection, checks the schema, generates a trusted token for Claude Code, and outputs the exact `claude mcp add` command if the installer didn't already run it.

---

## Verify it's working

Open a new terminal (so the shell exports take effect), then:

```bash
sci status
```

Expected output:

```
ok: true
episodic:        0
semantic:        0
identity:        0
embeddings:      0
queue (pending): 0
```

Counts are zero on a fresh install. That's expected — they grow as you use Claude Code.

Then run a live privacy check:

```bash
node demo/privacy-demo.mjs
```

This sends a real request through the proxy and prints a before/after comparison showing what left your machine. All 6 checks must pass before you trust the system with real conversations.

Sample output:

```
  What you sent:
    "My name is Casey Zandbergen and my email is casey@example.com."

  What reached Anthropic:
    "My name is [PERSON_1] and my email is [EMAIL_1]."

  Anonymization:
    PERSON_1  →  Casey Zandbergen
    EMAIL_1   →  casey@example.com

  PASS — real name did not appear in the outbound request.
```

---

## Your first session

1. Open a new terminal (PATH and proxy env must be inherited)
2. Start Claude Code in any project: `claude`
3. Confirm the proxy env is active — ask Claude to run `echo $ANTHROPIC_BASE_URL`. It should print `http://127.0.0.1:3001`.
4. Use Claude Code normally. Sci intercepts each request transparently.
5. Start a **second** Claude Code session in a different directory. This is where memory injection becomes visible — Sci will include context from the first session without you doing anything.

---

## Confirming memory is flowing

Sci injects a system prompt prefix into each Claude Code session. It looks like this (visible if you ask Claude what's in its system prompt):

```
[Sci memory context]
Identity: Casey Zandbergen, software engineer, works in TypeScript/Node
Active projects: Sci (cognitive identity layer), Threadline
Recent: implemented identity_facts pipeline (2026-05-22)
[/Sci memory context]
```

The injected content grows as you store more memories. To seed it immediately from your Claude conversation history:

```bash
# Export from: claude.ai/settings/account → Privacy → Export Data
sci import --claude ~/Downloads/conversations.json
```

---

## Uninstall

```bash
# Stop the background service
brew services stop sci          # if installed via brew
# or
launchctl unload ~/Library/LaunchAgents/com.cognitive-os.sci.plist

# Remove the binary
sudo rm /usr/local/bin/sci

# Remove config and data (destructive — removes all stored memories)
rm -rf ~/.sci

# Remove MCP registration
claude mcp remove sci

# Remove shell exports (edit ~/.zshrc manually and remove the Sci block)

# Remove CA from Keychain (optional)
# Open Keychain Access → search "Sci" → delete the certificate
```

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl: (60) SSL certificate problem` | CA not trusted in Keychain | `sci-helper --trust-ca` |
| `Connection refused` on port 3001 | Proxy not running | `brew services start sci` or check `~/Library/Logs/sci/sci-helper.log` |
| First request hangs 30–120 seconds | BGE embedding model downloading on first run (~110 MB) | Wait — check progress with `brew services log sci` |
| 401 from Anthropic | API key missing or not loaded | `sci-helper --setup` to re-enter key, or `curl -s http://127.0.0.1:3002/reload-credentials` |
| `sci: command not found` | PATH not updated | Open a new terminal or run `source ~/.zshrc` |
| Claude Code bypasses proxy | `ANTHROPIC_BASE_URL` not set in Claude Code's environment | Launch Claude Code from a terminal, not from the Dock/Spotlight |
| `brew update` fails with port 3001 error | `NO_PROXY` not excluding brew hosts | Add `export NO_PROXY=localhost,127.0.0.1,*.brew.sh,formulae.brew.sh,raw.githubusercontent.com` to `~/.zshrc` |

See [docs/INSTALL.md](INSTALL.md) for detailed diagnosis steps for each of these.

---

## Feedback

This is alpha software. Things will break. Please report what you find:

- **GitHub Issues:** [github.com/sovereign-cognitive-identity/sci/issues](https://github.com/sovereign-cognitive-identity/sci/issues) (preferred)
- **Email:** casey.zandbergen@gmail.com

When reporting a bug, include the output of `sci status` and the relevant lines from `~/Library/Logs/sci/sci-helper.log`.
