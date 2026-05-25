# Using Sci

Once Sci is installed, most of what it does is invisible — the proxy runs in the background and memory flows automatically. This guide covers what to expect and how to interact with it deliberately.

---

## What happens automatically

Every time you run `claude` in a terminal:

1. **Proxy intercepts the session.** All requests go through `localhost:3001` before reaching Anthropic. Your API key never changes — Sci forwards it.
2. **PII is anonymized outbound.** Your name, email, and other identity tokens are replaced with stable placeholders (`[PERSON_1]`, `[EMAIL_1]`) before the request leaves your machine.
3. **PII is restored inbound.** Claude's response comes back through the proxy, where placeholders are swapped back to your real values. You never see the substitution.
4. **Memory is available as tools.** The `sci` MCP server is registered in Claude Code, giving Claude access to `memory_recall`, `memory_store`, `memory_identity`, and `memory_status`.

You don't need to do anything for this to work. Open a terminal, run `claude`, and Sci is active.

---

## Confirming Sci is active

Two quick checks:

```bash
sci status
```

```
ok: true
episodic:        42
semantic:        18
identity:        87
embeddings:      147
queue (pending): 0
```

`ok: true` means the proxy and database are reachable. If any count is non-zero, memory has been stored.

```bash
sci verify
```

This sends a real proxied request containing your name and confirms it doesn't appear in the outbound payload. Expect output like:

```
  What you sent:
    "My name is Casey Zandbergen."

  What reached Anthropic:
    "My name is [PERSON_1]."

  PASS — real name did not appear in the outbound request.
```

Run `sci verify` any time you want to spot-check that anonymization is working.

---

## Asking Claude to recall context

Claude won't proactively call `memory_recall` unless instructed — either by a CLAUDE.md file or by you directly in the session.

**At the start of a session**, ask:

> "Check what you know about me and my active projects."

Claude will call `memory_identity` and `memory_recall` and summarize what it finds. From that point on, the context is loaded and Claude will draw on it.

**Mid-session**, if you reference something past, prompt:

> "Do you have any memory of my decisions around auth?"

Claude will call `memory_recall` with your query and return ranked results.

**Global instruction (recommended):** Add this to `~/.claude/CLAUDE.md` so Claude loads context on every session start automatically:

```markdown
## Memory

At the start of each session, call `memory_recall` with a query relevant 
to the current task, and `memory_identity` with no arguments to load 
Casey's context.
```

---

## Storing memories

Claude can store memories during a session when you ask:

> "Remember that we decided to use Postgres over SQLite for ops simplicity."

Claude calls `memory_store` with the content. The memory is embedded locally and persisted — no external API call is made for embeddings.

You can also store directly from the terminal:

```bash
# Not a CLI command — use the MCP tool via Claude Code.
# If you want to store without opening Claude, use the HTTP API:
curl -s -X POST http://127.0.0.1:3002/memory \
  -H "Content-Type: application/json" \
  -d '{"content": "Decided to use Postgres over SQLite for ops simplicity"}'
```

> **Alpha note:** The `sci` CLI doesn't have a `memory store` subcommand yet. Store via Claude Code (ask Claude to call `memory_store`) or via the HTTP API above.

---

## Seeding memories from past conversations

If you have an existing Claude conversation history, you can import it to give Sci an immediate head start:

1. Go to [claude.ai/settings/account](https://claude.ai/settings/account) → Privacy → Export Data
2. Download and unzip — you'll find `conversations.json`
3. Run:

```bash
sci import --claude ~/Downloads/conversations.json
```

This processes up to 100 conversations by default, extracting episodic memories and identity facts. Use `--limit` to import more:

```bash
sci import --claude ~/Downloads/conversations.json --limit 500
```

Import takes 30–90 seconds depending on volume. Check the result:

```bash
sci status
```

Counts should jump significantly after a large import.

---

## The four MCP tools

These are what Claude Code sees as callable tools. You can ask Claude to call any of them directly.

| Tool | Ask Claude to... | Use when |
|------|-----------------|----------|
| `memory_recall` | "Search your memory for X" | Retrieving past decisions, preferences, project context |
| `memory_store` | "Remember that X" | Capturing a decision, preference, or insight worth keeping |
| `memory_identity` | "What do you know about me?" | Loading your profile, preferences, active projects |
| `memory_status` | "Check memory status" | Verifying the system is healthy |

---

## What's not in the alpha yet

- **Auto-update** — you'll need to pull and rebuild manually for new versions
- **GUI** — no menu bar app yet; everything is terminal + Claude Code
- **Cloud storage sync** — memories are local only (Postgres in Docker)
- **Multi-provider routing** — only Anthropic for now; other providers bypass the proxy
- **Nightly consolidation** — the scheduled semantic memory pass is not active in v0.1.0

---

## Reporting bugs

This is alpha software. Include these two things in every bug report:

1. Output of `sci status`
2. Relevant lines from `~/Library/Logs/sci/sci-helper.log`

Report via [GitHub Issues](https://github.com/sovereign-cognitive-identity/sci/issues) or email casey.zandbergen@gmail.com.
