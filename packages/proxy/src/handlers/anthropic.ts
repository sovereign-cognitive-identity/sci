/**
 * Anthropic Messages API handler — POST /v1/messages
 *
 * Receives requests in Anthropic format (what Claude Code sends),
 * anonymizes, injects memory context, routes through OpenRouter,
 * streams back deanonymized responses in Anthropic SSE format.
 *
 * Anthropic request format:
 *   { model, messages: [{role, content}], system?, max_tokens, stream }
 *
 * Anthropic SSE format:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 */

import type { Context } from 'hono'
import { anonymize } from '@sci/core'
import type { StorageAdapter } from '@sci/core'
import { DeanonymizingStreamV2 } from '../stream/deanonymizer.js'
import { streamFromOpenRouter } from '../openrouter.js'
import type { OpenRouterMessage } from '../openrouter.js'
import { streamDirectAnthropic } from '../direct-anthropic.js'
import { injectMemoryContext, storeInteraction } from '../middleware/memory.js'
import { selectModel } from '../router.js'

const ROUTING_MODE = process.env['SCI_ROUTING_MODE'] ?? 'direct'

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string }>
}

interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

function extractText(content: AnthropicMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('')
}

function toOpenRouterMessages(
  messages: AnthropicMessage[],
  system?: string
): OpenRouterMessage[] {
  const result: OpenRouterMessage[] = []
  if (system) result.push({ role: 'system', content: system })
  for (const m of messages) {
    result.push({ role: m.role, content: extractText(m.content) })
  }
  return result
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function handleAnthropicMessages(
  c: Context,
  adapter: StorageAdapter,
  openrouterKey: string
): Promise<Response> {
  const body = await c.req.json<AnthropicRequest>()
  const streaming = body.stream !== false

  // Extract the last user message for anonymization + memory
  const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
  const originalUserText = lastUserMsg ? extractText(lastUserMsg.content) : ''
  const reqId = `req_${Date.now().toString(36)}`
  const t0 = Date.now()
  process.stderr.write(`\n[${new Date().toISOString()}] ${reqId} ── incoming (${body.model}, ${body.messages.length} msgs)\n`)

  // 1. Anonymize all user messages
  let sessionTokenMap = { forward: new Map<string, string>(), reverse: new Map<string, string>() }
  const anonymizedMessages: AnthropicMessage[] = body.messages.map(m => {
    if (m.role !== 'user') return m
    const text = extractText(m.content)
    const result = anonymize(text, sessionTokenMap)
    sessionTokenMap = result.tokenMap
    return { ...m, content: result.text }
  })

  // Log what got masked
  if (sessionTokenMap.forward.size > 0) {
    const masked = [...sessionTokenMap.forward.entries()].map(([e, t]) => `${t}←"${e.slice(0,30)}"`).join('  ')
    process.stderr.write(`[${reqId}] 🔒 masked ${sessionTokenMap.forward.size}: ${masked}\n`)
  } else {
    process.stderr.write(`[${reqId}] ✓  no entities detected\n`)
  }

  // 2. Inject memory context into anonymized messages
  const anonymizedWithContext = toOpenRouterMessages(anonymizedMessages, body.system)
  const withContext = await injectMemoryContext(anonymizedWithContext, adapter)

  const memCtx = withContext.find(m => m.role === 'system' && m.content.includes('[Sci Memory'))
  if (memCtx) {
    const lines = memCtx.content.split('\n').filter(l => l.startsWith('-')).length
    process.stderr.write(`[${reqId}] 🧠 injected ${lines} memory context items\n`)
  }

  // 3. Select model (used for OpenRouter mode; direct mode uses original)
  const model = selectModel(body.model, originalUserText)
  process.stderr.write(`[${reqId}] → ${ROUTING_MODE === 'direct' ? 'api.anthropic.com' : 'openrouter.ai'} (${body.model})\n`)

  // ── Direct mode: forward to Anthropic with original auth ─────────────────
  if (ROUTING_MODE === 'direct') {
    // Rebuild anonymized Anthropic-format request body
    const anonymizedBody = {
      ...body,
      messages: anonymizedMessages,
      system: withContext.find(m => m.role === 'system')?.content ?? body.system,
      stream: true,
    }

    // Extract original auth headers to forward to Anthropic
    const authHeader = c.req.header('authorization') ?? c.req.header('x-api-key')
    const originalHeaders: Record<string, string> = {
      'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
      ...(authHeader?.startsWith('Bearer ')
        ? { 'authorization': authHeader }
        : { 'x-api-key': authHeader ?? '' }),
    }

    const deanonStream = new DeanonymizingStreamV2(sessionTokenMap)
    const readable = await streamDirectAnthropic(
      '/v1/messages',
      anonymizedBody,
      originalHeaders,
      (text) => deanonStream.push(text),
      () => deanonStream.end(),
      () => {
        const ms = Date.now() - t0
        process.stderr.write(`[${reqId}] ✓  complete in ${ms}ms, storing to memory\n`)
        storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => {})
      }
    )

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Sci-Mode': 'direct',
        'X-Sci-Model': body.model,
      },
    })
  }

  // ── OpenRouter mode: translate and route ─────────────────────────────────
  const openRouterMessages = withContext

  if (!streaming) {
    const chunks: string[] = []
    for await (const delta of streamFromOpenRouter(
      { model, messages: openRouterMessages, max_tokens: body.max_tokens, stream: true },
      openrouterKey
    )) chunks.push(delta)
    const deanonStream = new DeanonymizingStreamV2(sessionTokenMap)
    deanonStream.push(chunks.join(''))
    const response = deanonStream.end()
    storeInteraction(originalUserText, response, adapter).catch(() => {})
    return c.json({
      id: `msg_${Date.now()}`,
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: response }],
      model, stop_reason: 'end_turn',
    })
  }

  // OpenRouter streaming
  const deanonStream = new DeanonymizingStreamV2(sessionTokenMap)
  const encoder = new TextEncoder()

  const readable = new ReadableStream({
    async start(controller) {
      const msgId = `msg_${Date.now()}`

      controller.enqueue(encoder.encode(sseEvent('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null },
      })))
      controller.enqueue(encoder.encode(sseEvent('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      })))

      try {
        for await (const delta of streamFromOpenRouter(
          { model, messages: openRouterMessages, max_tokens: body.max_tokens, stream: true },
          openrouterKey
        )) {
          const safe = deanonStream.push(delta)
          if (safe) controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
            type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: safe },
          })))
        }
        const final = deanonStream.end()
        if (final) controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: final },
        })))
      } catch (err) {
        controller.enqueue(encoder.encode(
          sseEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } })
        ))
      }

      controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })))
      controller.enqueue(encoder.encode(sseEvent('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 },
      })))

      // message_stop
      controller.enqueue(encoder.encode(
        sseEvent('message_stop', { type: 'message_stop' })
      ))

      controller.close()

      // Store interaction after stream completes — fire and forget
      storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => {})
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Sci-Model': model,
    },
  })
}
