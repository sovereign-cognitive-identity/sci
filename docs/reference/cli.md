# CLI Reference

All commands require `SCI_DB_READER_URL` and `SCI_DB_WRITER_URL` environment variables.

## sci status

Check database health and memory counts.

```bash
sci status
```

```
ok: true
episodic:        1009
semantic:        402
identity:        332
embeddings:      1744
queue (pending): 0
```

## sci setup

First-run wizard. Verifies DB connection, checks schema, generates a trusted token for Claude Code.

```bash
sci setup
```

Run this once after `docker compose up`. It outputs the exact `claude mcp add` command to register Sci with Claude Code.

## sci import

Seed memories from a Claude conversation export.

```bash
sci import --claude <file> [--profile <name>] [--limit <n>] [--verbose]
```

| Option | Default | Description |
|---|---|---|
| `--claude <file>` | required | Path to `conversations.json` from claude.ai export |
| `--profile <name>` | `work` | Target profile |
| `--limit <n>` | `100` | Max conversations to import |
| `--verbose` | false | Log every stored memory |

Export your conversation history from [claude.ai/settings/account](https://claude.ai/settings/account) → Privacy → Export Data.

## sci connect

Register an agent and generate an access token.

```bash
sci connect <name> [--tier <tier>] [--profile <name>]
```

| Option | Default | Description |
|---|---|---|
| `--tier` | `standard` | `trusted` \| `standard` \| `public` |
| `--profile` | none | Profile to scope access to (standard tier only) |

Outputs the token (shown once) and an MCP config snippet.

## sci agents

List all connected agents.

```bash
sci agents
```

## sci revoke

Revoke an agent's access token.

```bash
sci revoke <name>
```

The token is immediately invalidated.

## sci backup

Export all data to a portable JSON file.

```bash
sci backup [--out <path>]
```

Default output: `./sci-backup-YYYY-MM-DD.json`

## sci restore

Restore data from a JSON backup.

```bash
sci restore <file> [--force]
```

Without `--force`, fails if the database already has data. With `--force`, clears existing data first.
