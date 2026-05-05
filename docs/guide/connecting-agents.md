# Connecting Agents

Sci uses a three-tier access model. Every agent gets a token scoped to exactly what it needs.

## Tiers

| Tier | Use for | Access |
|---|---|---|
| `trusted` | Your own agents (Claude Code, personal scripts) | Full access to all tools and all profiles |
| `standard` | Third-party apps, work tools (Cursor, Copilot) | Read + write, but scoped to one profile only |
| `public` | External integrations, read-only consumers | Read-only, identity filtered to preferences only |

## Connect an agent

```bash
# Your primary AI assistant — full trusted access
sci connect claude-code --tier trusted

# Cursor scoped to your work profile
sci connect cursor --tier standard --profile work

# A read-only integration
sci connect some-app --tier public
```

Each command outputs the token and an exact MCP config snippet.

## Token format

Tokens encode their tier in the prefix:
- `sci_t_...` — trusted
- `sci_s_...` — standard
- `sci_p_...` — public

## Add to MCP config

The `sci connect` output gives you the exact command. For Claude Code:

```bash
claude mcp add cursor \
  -e SCI_AGENT_TOKEN="sci_s_..." \
  -e SCI_DB_READER_URL="postgresql://sci_reader:sci_reader_local@localhost:5432/sci" \
  -e SCI_DB_WRITER_URL="postgresql://sci_writer:sci_writer_local@localhost:5432/sci" \
  -- node /path/to/sci/packages/mcp/dist/index.js
```

For other MCP clients, use the JSON config format printed by `sci connect`.

## List connected agents

```bash
sci agents
```

Output:
```
Connected agents:

  claude-code          [trusted]            last used: today    token: ...abc1
  cursor               [standard → work]    last used: never    token: ...def2
```

## Revoke access

```bash
sci revoke cursor
```

The token is immediately invalidated. Run `sci connect cursor` to issue a new one.

## Auth enforcement

Standard tier agents that try to call `memory_identity` get:
```json
{ "error": "Access denied: Tier 'standard' cannot perform action 'readIdentity'" }
```

Identity facts are global (cross-profile) — a standard agent scoped to `work` shouldn't see your `personal` profile's relationships.

## Local development (no auth)

By default, the MCP server runs without auth enforcement. Set `SCI_REQUIRE_AUTH=true` to enforce tokens. This is off by default to keep the local dev experience frictionless.
