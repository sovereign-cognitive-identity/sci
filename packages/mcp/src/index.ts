#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createStorageAdapter } from '@sci/core'
import type { StorageAdapter } from '@sci/core'
import { memoryStatus } from './tools/status.js'
import { memoryStore } from './tools/store.js'
import { memoryStoreIdentity } from './tools/store-identity.js'
import { memoryIdentity } from './tools/identity.js'
import { memoryRecall } from './tools/recall.js'
import { messageAnonymize, messageDeanonymize, sessionInspect } from './tools/anonymize.js'
import { routeQuery } from './tools/router.js'
import { loadAgentContext, assertCan, resolveProfileId, AuthError } from './auth.js'
import type { AgentContext } from './auth.js'

// Initialise storage adapter and agent context at startup
const adapter: StorageAdapter = await createStorageAdapter()
const agentCtx: AgentContext = await loadAgentContext()

// Log auth context (helps debug connection issues)
process.stderr.write(
  `[sci] connected: ${agentCtx.agentName} (${agentCtx.tier})\n`
)

const server = new McpServer({
  name: 'sci',
  version: '0.3.0',
})

// ── Memory tools ──────────────────────────────────────────────────────────────

server.tool(
  'memory_status',
  'Health check: storage backend, row counts, last write timestamp',
  {},
  async () => {
    const result = await memoryStatus()
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'memory_store',
  'Store a new episodic memory. Generates an embedding and persists to the configured storage backend.',
  {
    content: z.string().describe('The memory content to store'),
    profile: z.string().optional().describe('Profile name (default: work)'),
    source: z.string().optional().describe('Source agent or tool (default: claude)'),
    metadata: z.record(z.unknown()).optional().describe('Optional metadata'),
  },
  async (args) => {
    try {
      assertCan(agentCtx, 'write')
      const profileId = await resolveProfileId(args.profile, agentCtx, adapter)
      const profileName = (await adapter.getProfiles()).find(p => p.id === profileId)?.name ?? args.profile ?? 'work'
      const result = await memoryStore({ ...args, profile: profileName })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof AuthError ? `Access denied: ${err.message}` : (err instanceof Error ? err.message : String(err))
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

server.tool(
  'memory_identity',
  'Retrieve identity facts about the user — preferences, values, skills, relationships. Provide a query for semantic search, or omit to get top facts by confidence.',
  {
    query: z.string().optional().describe('Semantic search query over identity facts'),
    category: z.string().optional().describe('Filter by category: preference, value, skill, relationship'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
  async (args) => {
    try {
      assertCan(agentCtx, 'readIdentity')
      // Public tier: filter to preferences only
      const rules = (await import('@sci/core')).TIER_RULES[agentCtx.tier]
      const category = rules.identityCategoryFilter
        ? (args.category ?? rules.identityCategoryFilter[0])
        : args.category
      const result = await memoryIdentity({ ...args, category })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof AuthError ? `Access denied: ${err.message}` : (err instanceof Error ? err.message : String(err))
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

server.tool(
  'memory_recall',
  'Semantic search across episodic, semantic, and identity memory. Returns ranked results.',
  {
    query: z.string().describe('Natural language query'),
    profile: z.string().optional().describe('Profile name (default: work)'),
    limit: z.number().optional().describe('Max results (default: 10)'),
    memory_types: z
      .array(z.enum(['episodic', 'semantic', 'identity']))
      .optional()
      .describe('Memory types to search (default: all)'),
  },
  async (args) => {
    try {
      const profileId = await resolveProfileId(args.profile, agentCtx, adapter)
      const profile = (await adapter.getProfiles()).find(p => p.id === profileId)
      const result = await memoryRecall({ ...args, profile: profile?.name ?? args.profile })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

server.tool(
  'memory_store_identity',
  'Store a durable identity fact about the user (preference, value, skill, relationship, project, context). Only store facts clearly supported by evidence — not inferred.',
  {
    content: z.string().describe('One concise sentence stating the identity fact'),
    category: z.string().optional().describe('Category: preference, value, skill, relationship, project, context'),
    confidence: z.number().optional().describe('Confidence 0.0–1.0: 0.9+ = explicitly stated, 0.7 = strongly implied, 0.5 = weakly implied'),
  },
  async (args) => {
    try {
      assertCan(agentCtx, 'write')
      const result = await memoryStoreIdentity(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof AuthError ? `Access denied: ${err.message}` : (err instanceof Error ? err.message : String(err))
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

// ── Anonymization tools ───────────────────────────────────────────────────────

server.tool(
  'message_anonymize',
  'Anonymize a message before sending to an AI provider. Detects and replaces PERSON, ORG, PLACE, EMAIL, PHONE, URL, HANDLE entities with tokens. Returns anonymized text and a session_id to use for deanonymization.',
  {
    text: z.string().describe('The message to anonymize'),
    session_id: z.string().optional().describe('Existing session ID to reuse token map across a conversation. Omit to start a new session.'),
  },
  async (args) => {
    try {
      assertCan(agentCtx, 'anonymize')
      const result = await messageAnonymize(args, adapter)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof AuthError ? `Access denied: ${err.message}` : (err instanceof Error ? err.message : String(err))
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

server.tool(
  'message_deanonymize',
  'Restore real entity values in a model response using the session token map. Optionally discard the session when done.',
  {
    text: z.string().describe('The model response to deanonymize'),
    session_id: z.string().describe('Session ID returned by message_anonymize'),
    discard_session: z.boolean().optional().describe('Discard the token map after deanonymizing (default: false)'),
  },
  async (args) => {
    const result = messageDeanonymize(args)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'session_inspect',
  'Inspect the token map for a session — shows which real entities have been masked. Use to verify anonymization before sending a prompt.',
  {
    session_id: z.string().describe('Session ID to inspect'),
  },
  async (args) => {
    const result = sessionInspect(args)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// ── Model router ──────────────────────────────────────────────────────────────

server.tool(
  'route_query',
  'Get the recommended model and API config for a given query. Routes by task type, context length, and cost.',
  {
    query: z.string().describe('The query or task description'),
    context_tokens: z.number().optional().describe('Estimated input token count'),
    priority: z.enum(['speed', 'quality', 'cost']).optional().describe('Routing priority (default: quality)'),
  },
  async (args) => {
    try {
      assertCan(agentCtx, 'route')
      const result = routeQuery(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const msg = err instanceof AuthError ? `Access denied: ${err.message}` : (err instanceof Error ? err.message : String(err))
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
    }
  }
)

// Graceful shutdown — drain storage adapter before exit
process.on('SIGTERM', async () => { await adapter.disconnect(); process.exit(0) })
process.on('SIGINT', async () => { await adapter.disconnect(); process.exit(0) })

const transport = new StdioServerTransport()
await server.connect(transport)
