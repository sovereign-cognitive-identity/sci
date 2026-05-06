/**
 * Sci UI server — minimal Hono app on http://localhost:3002 by default.
 *
 *   POST /chat
 *     body: { conversationId?, message, model?, system?, maxTokens? }
 *     Streams an SSE response of Anthropic-format deltas, exactly as
 *     the Sci proxy emits them. After the stream ends, persists the
 *     user and assistant turns to episodic_memories.
 *
 *   GET  /conversations            list recent conversations (JSON)
 *   GET  /conversations/:id        full turn list (JSON)
 *   DELETE /conversations/:id      delete a conversation (JSON)
 *
 *   GET  /auth/status              { authed: bool, expiresAt?, scope? }
 *     We don't expose login through HTTP — login opens a browser, which
 *     would race with the user's chat tab. Run `sci-ui-auth login` first.
 *
 *   GET  /                         serves public/index.html
 *   GET  /static/*                 serves public/<file>
 *
 * Architecture:
 *   browser ─POST /chat─▶ this server ─POST /v1/messages─▶ Sci proxy
 *                                                          ↓
 *                                                          api.anthropic.com
 *                                                          ↓
 *                                                          (anonymize → memory inject → forward → deanonymize)
 *                                                          ↓
 *           ◀──SSE relay (passthrough)─────────────────────┘
 *
 * The server is a thin SSE relay + a turn-persistence hook. All the
 * privacy work is in the proxy, not here.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { getAccessTokenSafe, ANTHROPIC_OAUTH_BETA, readCache } from './oauth.js'
import {
  appendTurn,
  loadConversation,
  listConversations,
  deleteConversation,
  newConversationId,
  getProfileId,
} from './conversation.js'

// ── Config ────────────────────────────────────────────────────────────────────

const PORT       = Number(process.env['SCI_UI_PORT'] ?? 3002)
const PROXY_URL  = process.env['SCI_PROXY_URL'] ?? 'http://localhost:3001'
const DEFAULT_MODEL = process.env['SCI_UI_DEFAULT_MODEL'] ?? 'claude-haiku-4-5-20251001'
const DEFAULT_MAX_TOKENS = Number(process.env['SCI_UI_DEFAULT_MAX_TOKENS'] ?? 1024)

const __dirname = dirname(fileURLToPath(import.meta.url))
// public/ sits next to dist/ — i.e. ../public from this compiled file.
const PUBLIC_DIR = join(__dirname, '..', 'public')

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono()

app.get('/auth/status', (c) => {
  const cache = readCache()
  if (!cache) return c.json({ authed: false })
  return c.json({
    authed: true,
    expiresAt: cache.expires_at_ms ? new Date(cache.expires_at_ms).toISOString() : null,
    scope: cache.scope,
  })
})

app.get('/conversations', async (c) => {
  const conversations = await listConversations()
  return c.json({ conversations })
})

app.get('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  const turns = await loadConversation(id)
  return c.json({ id, turns })
})

app.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  const result = await deleteConversation(id)
  return c.json(result)
})

app.post('/chat', async (c) => {
  type ChatRequest = {
    conversationId?: string
    message: string
    model?: string
    system?: string
    maxTokens?: number
  }
  const body = await c.req.json<ChatRequest>()
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'missing message' }, 400)
  }

  const conversationId = body.conversationId ?? newConversationId()
  const model = body.model ?? DEFAULT_MODEL
  const maxTokens = body.maxTokens ?? DEFAULT_MAX_TOKENS

  // Get a fresh access token (auto-refresh if near-expiry).
  let token: string
  try {
    token = await getAccessTokenSafe()
  } catch (err) {
    return c.json(
      { error: 'not authenticated', detail: (err as Error).message },
      401
    )
  }

  // Force the profile to exist before we start streaming, so the persistence
  // step at the end doesn't race on first use.
  await getProfileId()

  // Load prior turns to give the model conversation context.
  const priorTurns = body.conversationId ? await loadConversation(body.conversationId) : []
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...priorTurns
      .filter((t) => t.role === 'user' || t.role === 'assistant')
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
    { role: 'user', content: body.message },
  ]

  // POST upstream to the Sci proxy. The proxy will anonymize, inject
  // memory context, forward to Anthropic, deanonymize the stream, and
  // store the interaction itself for memory consolidation.
  const upstreamRes = await fetch(`${PROXY_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization':     `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    ANTHROPIC_OAUTH_BETA,
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
      ...(body.system ? { system: body.system } : {}),
    }),
  }).catch((err: Error) => {
    return new Response(
      JSON.stringify({ error: 'proxy unreachable', detail: err.message, proxyUrl: PROXY_URL }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  })

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text()
    return c.json(
      { error: 'upstream error', status: upstreamRes.status, body: text.slice(0, 1000) },
      upstreamRes.status as 400 | 401 | 500
    )
  }
  if (!upstreamRes.body) {
    return c.json({ error: 'upstream returned no body' }, 502)
  }

  // We tee the stream: one fork → browser, the other → assistant-text
  // accumulator + Sci inspector events. When accumulation finishes we
  // persist both turns, including inspector data on each turn's metadata.
  let assistantText = ''
  let sseBuffer = ''
  let lastEventName: string | null = null   // tracks `event:` line per SSE record
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let sciAnonymized: any = null   // payload from `event: sci.anonymized`     → user turn
  let sciDeanonymized: any = null // payload from `event: sci.deanonymized`   → assistant turn
  let sciMemory: any = null       // payload from `event: sci.memory`         → assistant turn
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const decoder = new TextDecoder()

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      sseBuffer += decoder.decode(chunk, { stream: true })
      let bound: number
      while ((bound = sseBuffer.indexOf('\n\n')) !== -1) {
        const eventBlock = sseBuffer.slice(0, bound)
        sseBuffer = sseBuffer.slice(bound + 2)
        let evName: string | null = null
        for (const line of eventBlock.split('\n')) {
          if (line.startsWith('event:')) {
            evName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const data = JSON.parse(payload)
              if (evName === 'sci.anonymized') {
                sciAnonymized = data
              } else if (evName === 'sci.deanonymized') {
                sciDeanonymized = data
              } else if (evName === 'sci.memory') {
                sciMemory = data
              } else if (
                data.type === 'content_block_delta' &&
                data.delta?.type === 'text_delta'
              ) {
                assistantText += data.delta.text ?? ''
              }
            } catch {
              /* keep relaying — partial JSON / non-JSON heartbeats are fine */
            }
          }
        }
        lastEventName = evName
      }
    },
    async flush() {
      // Persist regardless of stream success — partial assistant replies are
      // still useful in memory. Both writes are best-effort.
      // Inspector data attaches to the turn that semantically owns it:
      //   sci.anonymized   → user turn (what we hid before sending)
      //   sci.deanonymized → assistant turn (what we swapped back on the way home)
      try {
        await appendTurn({
          conversationId,
          role: 'user',
          content: body.message,
          model,
          inspector: sciAnonymized ? { anonymized: sciAnonymized } : undefined,
        })
      } catch (err) {
        console.error('[ui] persist user turn failed:', (err as Error).message)
      }
      if (assistantText.trim().length > 0) {
        const assistantInspector =
          sciDeanonymized || sciMemory
            ? {
                ...(sciDeanonymized ? { deanonymized: sciDeanonymized } : {}),
                ...(sciMemory       ? { memory: sciMemory }              : {}),
              }
            : undefined
        try {
          await appendTurn({
            conversationId,
            role: 'assistant',
            content: assistantText,
            model,
            inspector: assistantInspector,
          })
        } catch (err) {
          console.error('[ui] persist assistant turn failed:', (err as Error).message)
        }
      }
    },
  })

  return new Response(upstreamRes.body.pipeThrough(tap), {
    status: 200,
    headers: {
      'Content-Type':       'text/event-stream',
      'Cache-Control':      'no-cache',
      'Connection':         'keep-alive',
      'X-Sci-Conversation': conversationId,
    },
  })
})

// Static assets last so they don't shadow the API routes above.
app.use('/static/*', serveStatic({ root: PUBLIC_DIR, rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))
app.get('/', serveStatic({ path: 'index.html', root: PUBLIC_DIR }))

// ── Entry point ───────────────────────────────────────────────────────────────

export function startServer(): void {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Sci UI listening on http://localhost:${info.port}`)
    console.log(`  proxy:         ${PROXY_URL}`)
    console.log(`  default model: ${DEFAULT_MODEL}`)
    const cache = readCache()
    if (!cache) {
      console.log('')
      console.log('  ⚠ no OAuth token — run `npm run -w packages/ui auth login` first')
    } else if (cache.expires_at_ms && cache.expires_at_ms < Date.now()) {
      console.log('  ⚠ token expired — will auto-refresh on first request')
    }
  })
}

// Allow `node dist/server.js` to start the server directly.
const isEntry = import.meta.url === `file://${process.argv[1]}`
if (isEntry) startServer()

export { app }
