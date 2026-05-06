/**
 * Conversation persistence — chat turns as episodic memories.
 *
 * We piggyback on Sci's existing `episodic_memories` table rather than
 * introducing a separate conversations table. Each turn is one row, tagged
 * with `source = 'sci-ui'` and `metadata = { conversation_id, role, model? }`.
 *
 * This means:
 *   - Every turn gets embedded and is recallable by Sci's memory tools, just
 *     like any other memory. The chat history IS the episodic memory.
 *   - Listing/loading conversations is a metadata filter on the same table,
 *     no schema migration needed.
 *
 * Profile: we use the singleton `'work'` profile that the Sci proxy already
 * uses (created lazily on first write). Multi-profile support is a Tier 2
 * concern — not now.
 *
 * Read paths use the Postgres reader pool directly because the
 * StorageAdapter interface doesn't expose a "list episodics by metadata"
 * query. That makes this module Postgres-specific for now; cloud adapters
 * (Dropbox / S3 / iCloud) won't work for read-back until we extend the
 * interface. For Tier 1 (LocalAdapter only) this is fine.
 */

import { randomUUID } from 'node:crypto'
import { reader, embed, createStorageAdapter } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system'

export interface Turn {
  id: string
  role: Role
  content: string
  occurredAt: Date
  model?: string
}

export interface ConversationSummary {
  id: string
  startedAt: Date
  lastAt: Date
  turnCount: number
  /** First user message, truncated. Empty string if not available. */
  preview: string
}

interface TurnMetadata {
  conversation_id: string
  role: Role
  model?: string
}

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _adapter: StorageAdapter | null = null
let _profileIdPromise: Promise<string> | null = null

async function adapter(): Promise<StorageAdapter> {
  if (_adapter) return _adapter
  _adapter = await createStorageAdapter()
  return _adapter
}

/**
 * Returns the singleton 'work' profile id. Creates the profile on first
 * call if it doesn't exist. Memoized so repeated calls are free.
 */
export async function getProfileId(): Promise<string> {
  if (!_profileIdPromise) {
    _profileIdPromise = (async () => {
      const a = await adapter()
      const existing = await a.getProfile('work')
      if (existing) return existing.id
      const created = await a.createProfile('work')
      return created.id
    })()
  }
  return _profileIdPromise
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Generate a fresh conversation id. UUIDv4. */
export function newConversationId(): string {
  return randomUUID()
}

/**
 * Append one turn to a conversation. Embeds the content and writes to
 * episodic_memories. Returns the new turn id.
 *
 * `content` is the deanonymized (real) text — that's what Sci memory wants
 * for recall. The wire-level anonymization happens in the proxy, separately.
 */
export async function appendTurn(args: {
  conversationId: string
  role: Role
  content: string
  model?: string
}): Promise<{ id: string }> {
  const profileId = await getProfileId()
  const a = await adapter()
  const embedding = await embed(args.content)

  const metadata: TurnMetadata = {
    conversation_id: args.conversationId,
    role: args.role,
    ...(args.model ? { model: args.model } : {}),
  }

  return a.storeEpisodic({
    profileId,
    content: args.content,
    embedding,
    source: 'sci-ui',
    metadata: metadata as unknown as Record<string, unknown>,
  })
}

/**
 * Load all turns for a conversation, oldest first.
 *
 * Postgres-only for now (uses the reader pool directly).
 */
export async function loadConversation(conversationId: string): Promise<Turn[]> {
  const result = await reader.query<{
    id: string
    content: string
    occurred_at: Date
    metadata: TurnMetadata
  }>(
    `SELECT id, content, occurred_at, metadata
     FROM episodic_memories
     WHERE source = 'sci-ui'
       AND metadata->>'conversation_id' = $1
     ORDER BY occurred_at ASC`,
    [conversationId]
  )

  return result.rows.map((r) => ({
    id: r.id,
    role: r.metadata.role,
    content: r.content,
    occurredAt: new Date(r.occurred_at),
    ...(r.metadata.model ? { model: r.metadata.model } : {}),
  }))
}

/**
 * List recent conversations with a preview (first user turn) and
 * basic stats. Most-recent-activity first, capped at `limit`.
 *
 * Postgres-only for now.
 */
export async function listConversations(limit = 50): Promise<ConversationSummary[]> {
  const result = await reader.query<{
    id: string
    started_at: Date
    last_at: Date
    turn_count: string
    preview: string | null
  }>(
    `WITH conv AS (
       SELECT
         metadata->>'conversation_id' AS id,
         MIN(occurred_at) AS started_at,
         MAX(occurred_at) AS last_at,
         COUNT(*) AS turn_count
       FROM episodic_memories
       WHERE source = 'sci-ui'
         AND metadata->>'conversation_id' IS NOT NULL
       GROUP BY metadata->>'conversation_id'
     ),
     first_user AS (
       SELECT DISTINCT ON (metadata->>'conversation_id')
         metadata->>'conversation_id' AS id,
         content
       FROM episodic_memories
       WHERE source = 'sci-ui'
         AND metadata->>'role' = 'user'
       ORDER BY metadata->>'conversation_id', occurred_at ASC
     )
     SELECT c.id, c.started_at, c.last_at, c.turn_count, f.content AS preview
     FROM conv c
     LEFT JOIN first_user f USING (id)
     ORDER BY c.last_at DESC
     LIMIT $1`,
    [limit]
  )

  return result.rows.map((r) => ({
    id: r.id,
    startedAt: new Date(r.started_at),
    lastAt: new Date(r.last_at),
    turnCount: Number.parseInt(r.turn_count, 10),
    preview: (r.preview ?? '').slice(0, 120),
  }))
}

/**
 * Delete an entire conversation by id.
 *
 * Note: this only removes the episodic_memories rows; embeddings and
 * write_queue entries are left as-is (the embeddings table is keyed on
 * memory_id which won't resolve, but it's not load-bearing). If we ever
 * grow a "delete conversation" UX we should clean this up properly.
 */
export async function deleteConversation(conversationId: string): Promise<{ deleted: number }> {
  // Use the writer pool for DELETE.
  const { writer } = await import('@sci/core')
  const result = await writer.query(
    `DELETE FROM episodic_memories
     WHERE source = 'sci-ui'
       AND metadata->>'conversation_id' = $1`,
    [conversationId]
  )
  return { deleted: result.rowCount ?? 0 }
}
