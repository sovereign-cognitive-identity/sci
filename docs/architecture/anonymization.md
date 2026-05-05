# Anonymization Pipeline

The privacy guarantee in technical detail.

## Four detection layers

Every `message_anonymize` call runs four passes, in order:

### Layer 1 — Regex patterns

Highest precision. Pattern-matched — no ML, no false negatives on structured data.

| Pattern | Catches |
|---|---|
| Email regex | `casey@example.com` |
| Full URL | `https://openrouter.ai/...` |
| Bare domain | `CrossTimbersFarm.com`, `okiekatz.com` |
| Social handle | `@caseyz` (not preceded by email chars) |
| US phone | `(918) 555-1234`, `+1 918-555-1234` |

Emails are extracted first to prevent `@gmail` and `gmail.com` being re-matched as handle/domain.

### Layer 2 — compromise.js NER

Named entity recognition using a pre-trained English model. Identifies PERSON, PLACE, and ORG entities.

Works for everyone from day one. Fails on uncommon names, non-English text, and niche company names not in the training data.

### Layer 3 — Custom entities from identity_facts

Project names, company names, and personal entities extracted from your stored identity facts. 5-minute cache — invalidated on `sci revoke` or manual call.

Extraction from identity facts uses three sub-patterns:
- Backtick-quoted terms: `` `Threadline` ``, `` `OpenClaw` ``
- Single/double-quoted proper nouns: `'Sci'`, `'Serious Hobbyist'` (max 2 words)
- True compound CamelCase: `CrossTimbersFarm`, `BlueBubbles`, `ElevenLabs`

### Layer 4 — CamelCase heuristic

Catches compound CamelCase proper nouns that weren't caught by layers 1-3: `OpenClaw`, `ChromeTimbersFarm`, `RadarScope`. Requires at least one internal capital letter — doesn't catch single-capital words like `Email` or `Building`.

## Token format

Each detected entity gets a token: `[TYPE_N]` where TYPE is the entity category and N is a sequential number per type within the session.

```
"Casey Zandbergen" → [PERSON_1]
"casey@gmail.com"  → [EMAIL_1]
"Tulsa, Oklahoma"  → [PLACE_1]
"OpenClaw"         → [ORG_1]
"@caseyz"          → [HANDLE_1]
```

## Session store

Token maps live in a `Map<sessionId, SessionData>` in the MCP server process memory.

```typescript
interface SessionData {
  tokenMap: TokenMap         // entity ↔ token bidirectional map
  seenEntities: Entity[]     // all entities detected this session
}
```

**Never persisted.** When the MCP server process exits, all token maps are gone.

## Session feedback loop

If a new entity (e.g., `VelvetApp`) is caught in call 1 of a session, it's added to `seenEntities`. In call 2, `seenEntities` is passed as a custom entity list — `VelvetApp` is proactively checked even if NER wouldn't catch it in that grammatical context.

## Progressive promotion

Entities that appear in 3+ separate calls are promoted to `identity_facts` automatically, with confidence 0.6. This means they'll be caught via Layer 3 in all future sessions — even on a fresh MCP server start.

## What is NOT anonymized

The allowlist contains ~80 well-known technology and product names that don't reveal user identity: `TypeScript`, `Docker`, `GitHub`, `Claude`, `ChatGPT`, `Discord`, `Notion`, etc.

The principle: mask things that reveal *your* identity, not things that reveal what tools you use. The latter is inferrable from context anyway.

## The deanonymization round-trip

After the AI responds, call `message_deanonymize`:

```
"Hello [PERSON_1], your [PROJECT_2] is looking good."
                      ↓ reverse token map
"Hello Casey Zandbergen, your Threadline is looking good."
```

Set `discard_session: true` to clear the token map after the final deanonymization.

## Auditing

Before any outbound call, call `session_inspect` to see the full token map:

```json
{
  "found": true,
  "entities": [
    { "entity": "Casey Zandbergen", "token": "[PERSON_1]" },
    { "entity": "casey.zandbergen@gmail.com", "token": "[EMAIL_1]" }
  ]
}
```

This is the verifiable privacy guarantee. If your real name appears in the outbound text, something went wrong — and you can see it here before it leaves.
