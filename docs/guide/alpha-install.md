# Sci Alpha — Install Guide

> Alpha v0.1.0 · macOS · Apple Silicon · Invite only

## What you're getting

Sci is a local proxy that sits between Claude Code and Anthropic. Before any request leaves your machine, it substitutes your real name, email, and other PII with stable placeholder tokens, then restores them in the response. It also injects relevant memory context — facts about you, your projects, and past decisions — into every session via an MCP server connected to a local store. The alpha proves the core pipeline: anonymization, memory injection, and deanonymization all working end-to-end with Claude Code. What's not included yet: auto-update, a GUI, multi-provider routing, and cloud storage sync.

---

## Prerequisites

- macOS 13 or later, **Apple Silicon (M1 or newer)** — Intel Macs are not supported in the alpha
- Claude Code installed and working (`claude --version` should succeed)
- An Anthropic API key (`sk-ant-...`)
- An invite link from Casey

Storage is local SQLite — **no Docker or Postgres required**.

---

## Install

Run the installer in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/scripts/install.sh | bash
```

> The installer asks for `sudo` for two steps: trusting the CA certificate in your System Keychain and writing the launchd services.

The installer will:

1. Download the Sci binary for Apple Silicon and install it to `~/.sci/bin/`
2. Add `~/.sci/bin` to your `PATH` in `~/.zshrc`
3. Generate a local CA certificate and trust it in your macOS System Keychain
4. Register the `sci` MCP server in `~/.claude.json`
5. Write `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` into Claude Code's `settings.json`
6. Install and start the launchd services — `dev.sci.helper` (proxy, :3001) and `com.sci.agent` (:8080)
7. Prompt for your Anthropic API key and save it to `~/.sci/credentials.env`

When it finishes, you'll see a status summary.

---

## First-run setup

The installer completes setup for you — there is no separate wizard to run. If you ever need to re-enter your API key or re-register the MCP server, run:

```bash
sci --setup
```

---

## Verify it's working

Open a **new** terminal (so the `PATH` change takes effect), then:

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
sci verify
```

This sends a real request through the proxy and prints a before/after comparison showing what left your machine. The check must PASS before you trust the system with real conversations.

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
3. Confirm the proxy env is active — ask Claude to run `echo $HTTPS_PROXY`. It should print `http://127.0.0.1:3001`.
4. Use Claude Code normally. Sci intercepts each request transparently.
5. Start a **second** Claude Code session in a different directory. This is where memory injection becomes visible — Sci will include context from the first session without you doing anything.

See [Using Sci](/guide/using-sci) for day-to-day usage.

---

## Confirming memory is flowing

Sci exposes memory to Claude Code through the `sci` MCP server. Ask Claude directly:

> "What do you know about me and my active projects?"

Claude will call `memory_identity` and `memory_recall` and summarize what it finds.

To seed memory immediately from your Claude conversation history:

```bash
# Export from: claude.ai/settings/account → Privacy → Export Data
sci import --claude ~/Downloads/conversations.json
```

---

## Uninstall

```bash
# Stop and remove the background services
launchctl unload ~/Library/LaunchAgents/dev.sci.helper.plist
launchctl unload ~/Library/LaunchAgents/com.sci.agent.plist
rm ~/Library/LaunchAgents/dev.sci.helper.plist ~/Library/LaunchAgents/com.sci.agent.plist

# Remove MCP registration
claude mcp remove sci

# Remove config, binary, and data (destructive — erases all stored memories)
rm -rf ~/.sci

# Manually remove the PATH line from ~/.zshrc and the proxy env block
# (HTTPS_PROXY / NODE_EXTRA_CA_CERTS) from Claude Code's settings.json

# Remove CA from Keychain (optional):
# Keychain Access → search "Sci" → delete the certificate
```

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `sci: command not found` | PATH not updated | Open a new terminal or run `source ~/.zshrc` |
| `Connection refused` on port 3001 | Proxy not running | `launchctl load ~/Library/LaunchAgents/dev.sci.helper.plist`, then check `~/Library/Logs/sci-helper.log` |
| First request hangs 30–120 seconds | Embedding model downloading on first run (~110 MB) | Wait — `tail -f ~/Library/Logs/sci-helper.log` to watch progress |
| `curl: (60) SSL certificate problem` | CA not trusted in Keychain | Re-run the installer, or trust `~/.sci/ca.crt` in Keychain Access manually |
| 401 from Anthropic | API key missing or not loaded | `sci --setup` to re-enter your key |
| Claude Code bypasses proxy | `HTTPS_PROXY` not set in Claude Code's environment | Launch Claude Code from a terminal, not the Dock/Spotlight |

See [INSTALL.md](../INSTALL.md) for detailed diagnosis steps.

---

## Feedback

This is alpha software. Things will break. Please report what you find:

- **GitHub Issues:** [github.com/sovereign-cognitive-identity/sci/issues](https://github.com/sovereign-cognitive-identity/sci/issues) (preferred)
- **Email:** casey.zandbergen@gmail.com

When reporting a bug, include the output of `sci status` and the relevant lines from `~/Library/Logs/sci-helper.log`.
