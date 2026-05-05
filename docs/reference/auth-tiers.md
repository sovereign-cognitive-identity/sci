# Auth Tiers

Sci enforces three access tiers at the MCP server level.

## Tier comparison

| Tool | trusted | standard | public |
|---|---|---|---|
| `memory_recall` | ✓ all profiles | ✓ assigned profile only | ✓ read-only |
| `memory_store` | ✓ | ✓ assigned profile only | ✗ |
| `memory_identity` | ✓ all categories | ✗ | ✓ preferences only |
| `message_anonymize` | ✓ | ✓ | ✗ |
| `message_deanonymize` | ✓ | ✓ | ✗ |
| `session_inspect` | ✓ | ✓ | ✗ |
| `route_query` | ✓ | ✓ | ✗ |
| `memory_status` | ✓ | ✓ | ✓ |

## Token format

| Tier | Prefix | Example |
|---|---|---|
| trusted | `sci_t_` | `sci_t_a3f2...` |
| standard | `sci_s_` | `sci_s_b8c1...` |
| public | `sci_p_` | `sci_p_d4e7...` |

## Standard tier — profile scoping

Standard tier tokens are scoped to a single profile at connection time. The assigned profile cannot be overridden — `memory_recall` and `memory_store` always use the token's profile, ignoring any `profile` parameter in the tool call.

This means a `standard` token for the `work` profile cannot access `personal` memories, even if the agent requests it.

## Security model

- Tokens are 32-byte random hex strings
- Only SHA-256 hashes are stored in the database
- Plaintext is shown once at `sci connect` time and never again
- Revoke with `sci revoke <name>`
- No `SCI_AGENT_TOKEN` + `SCI_REQUIRE_AUTH=false` → defaults to trusted (local dev mode)

## Enforcement

Auth is enforced in the MCP server middleware before any tool executes. Unauthorized calls return:

```json
{
  "error": "Access denied: Tier 'standard' cannot perform action 'readIdentity'",
  "isError": true
}
```
