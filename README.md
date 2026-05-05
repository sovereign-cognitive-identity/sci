# Sci — Sovereign Cognitive Identity

A proxy that sits between you and every AI system you use. It protects your privacy, preserves your context across all AI tools, and optimizes your costs. Set it and forget it.

**The one-sentence version:** The Visa network for your AI life — it just works, everywhere, without you thinking about it.

---

## What it does

| | |
|---|---|
| **Memory** | Unified context that travels across Claude, Cursor, Copilot, and any MCP-compatible agent |
| **Privacy** | Anonymizes your identity before any cloud AI processing — providers see coherent context, never your real name |
| **Routing** | Routes each query to the best/cheapest model; you pay one subscription |

**What it is not:** a chatbot, a memory plugin, a RAG pipeline, a note-taking app.

## Quick start (self-hosted)

**Requirements:** Docker, Node.js 18+

```bash
git clone https://github.com/sovereign-cognitive-identity/sci
cd sci
npm install
docker compose up -d      # start Postgres with pgvector
npm run build
sci setup                 # generate your trusted token + MCP config
```

Then add the output from `sci setup` to your Claude Code MCP config and restart.

## Verify the privacy guarantee

```bash
node demo/privacy-demo.mjs
```

This runs in under 10 seconds and proves your real name never appears in the outbound text. All 6 checks must pass before you trust the system with your identity.

## Connect an agent

```bash
# Your own agents (full access)
sci connect my-agent --tier trusted

# Third-party apps (scoped to one profile)
sci connect cursor --tier standard --profile work

# Read-only access (preferences only, no writes)
sci connect some-app --tier public
```

Each command prints the token and an exact MCP config snippet to paste.

## CLI reference

```
sci status                          check DB health and memory counts
sci import --claude <file>          seed from Claude conversation export
sci connect <name> [--tier] [--profile]  connect an agent
sci agents                          list connected agents
sci revoke <name>                   revoke an agent's token
sci backup [--out <file>]           export all data to JSON
sci restore <file> [--force]        restore from a JSON backup
sci setup                           first-run wizard
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SCI_DB_READER_URL` | Yes | Postgres reader connection string |
| `SCI_DB_WRITER_URL` | Yes | Postgres writer connection string |
| `SCI_EMBED_MODEL` | No | Embedding model (default: `BAAI/bge-base-en-v1.5`) |
| `SCI_STORAGE_BACKEND` | No | `local` (default), `dropbox`, `s3`, `icloud` |
| `SCI_AGENT_TOKEN` | No | Agent token (required when `SCI_REQUIRE_AUTH=true`) |
| `SCI_OPENROUTER_KEY` | For consolidation | OpenRouter API key |
| `SCI_VAULT_PATH` | No | Path to Obsidian vault for nightly digests |

## Storage backends

Sci can store your data in four places. You choose at startup:

```bash
# Default: local Postgres (requires Docker)
SCI_STORAGE_BACKEND=local

# Your Dropbox — data lives in /CognitiveOS/
SCI_STORAGE_BACKEND=dropbox SCI_DROPBOX_TOKEN=...

# Any S3-compatible bucket (AWS, R2, MinIO, Backblaze)
SCI_STORAGE_BACKEND=s3 SCI_S3_BUCKET=... SCI_S3_REGION=...

# iCloud Drive (macOS only — syncs automatically)
SCI_STORAGE_BACKEND=icloud
```

The cloud backends use SQLite + hnswlib. Your entire memory store is two files: `sci.db` and `sci.idx`. Download them and you have everything.

## Nightly consolidation

Sci consolidates your memories every night at 3am:

1. **Episodic → semantic promotion** — extracts durable facts from today's conversations
2. **Ebbinghaus decay** — things you haven't thought about fade; things you reinforce strengthen
3. **Knowledge graph** — finds relationships between concepts
4. **Digest** — brief summary of the day, exported to your Obsidian vault

Schedule it yourself:
```bash
0 3 * * * cd /path/to/sci && SCI_OPENROUTER_KEY=... npm run consolidate -w packages/core
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full technical deep-dive.

## Security model

- Tokens are 32-byte random hex strings stored as SHA-256 hashes — plaintext shown once, never stored
- Three access tiers: `trusted` (full), `standard` (profile-scoped), `public` (read-only)
- The anonymization token map lives in process memory only — never written to disk or network
- `db_reader` and `db_writer` Postgres roles are strictly separated — no DELETE on either

## License

Sci is dual-licensed:

- **[AGPL-3.0](LICENSE)** — for open source use, self-hosting, and personal use
- **[Commercial License](COMMERCIAL_LICENSE.md)** — for managed service operators and proprietary embedding

If you self-host Sci for your own use, AGPL-3.0 applies and you owe nothing. If you want to offer Sci as a service to others without open-sourcing your stack, contact casey.zandbergen@gmail.com.
