# MCP Tools

The Sci MCP server exposes eight tools to connected agents.

## memory_recall

Semantic search across episodic, semantic, and identity memory.

```json
{
  "query": "what did I decide about auth last month?",
  "profile": "work",
  "limit": 10,
  "memory_types": ["episodic", "semantic", "identity"]
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural language search query |
| `profile` | string | `work` | Profile to search (standard tier: always uses assigned profile) |
| `limit` | number | `10` | Max results |
| `memory_types` | array | all | `episodic`, `semantic`, `identity` |

Returns results ranked by Reciprocal Rank Fusion across dense vector search and full-text search.

## memory_store

Store a new episodic memory.

```json
{
  "content": "Decided to use tsvector over Qdrant for simplicity of ops",
  "profile": "work",
  "source": "claude",
  "metadata": { "project": "sci" }
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `content` | string | required | The memory to store |
| `profile` | string | `work` | Target profile |
| `source` | string | `claude` | Source agent or tool |
| `metadata` | object | `{}` | Optional metadata |

Generates an embedding locally (no external API call) and persists to the storage backend.

## memory_identity

Retrieve identity facts — preferences, values, skills, relationships.

```json
{
  "query": "what stack does Casey prefer?",
  "category": "preference",
  "limit": 20
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Semantic search query (omit for top facts by confidence) |
| `category` | string | — | Filter: `preference`, `value`, `skill`, `relationship`, `project`, `context` |
| `limit` | number | `20` | Max results |

::: warning Auth restriction
Not available to `standard` tier agents. Identity facts are global (cross-profile).
:::

## memory_status

Health check.

```json
{}
```

Returns backend name, row counts (episodic/semantic/identity/embeddings), and last write timestamp.

## message_anonymize

Anonymize a message before sending to an AI provider.

```json
{
  "text": "My name is Casey Zandbergen and I work on Threadline",
  "session_id": "optional-existing-session-id"
}
```

Returns anonymized text, a `session_id` for deanonymization, entities masked count, and a breakdown by type.

Use `session_inspect` to audit the token map before sending.

## message_deanonymize

Restore real values in an AI response.

```json
{
  "text": "Hello [PERSON_1], your project [PROJECT_2] looks good.",
  "session_id": "abc123",
  "discard_session": true
}
```

Set `discard_session: true` when the conversation is done to clear the token map from memory.

## session_inspect

Audit the current token map for a session.

```json
{
  "session_id": "abc123"
}
```

Returns every entity→token mapping. Use this to verify anonymization before any outbound call.

::: tip
This is the launch gate: inspect the outbound text yourself and confirm your real name isn't there.
:::

## route_query

Get the recommended model for a given query.

```json
{
  "query": "implement a TypeScript function that...",
  "context_tokens": 2000,
  "priority": "quality"
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | The query or task description |
| `context_tokens` | number | `1000` | Estimated input token count |
| `priority` | string | `quality` | `quality`, `speed`, or `cost` |

Returns `model`, `provider`, `reason`, estimated cost, and context window.
