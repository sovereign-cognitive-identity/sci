/**
 * OpenAI Chat Completions handler — POST /v1/chat/completions
 *
 * Handles requests from Cursor, Copilot, and any OpenAI-compatible client.
 * Same pipeline as the Anthropic handler but in/out format stays OpenAI.
 *
 * OpenAI SSE format:
 *   data: {"choices":[{"delta":{"content":"text"},"finish_reason":null}]}
 *   data: [DONE]
 */

import type { Context } from 'hono'
import { anonymize } from '@sci/core'
import type { StorageAdapter } from '@sci/core'
import { DeanonymizingStreamV2 } from '../stream/deanonymizer.js'
import { streamFromOpenRouter } from '../openrouter.js'
import type { OpenRouterMessage } from '../openrouter.js'
import { injectMemoryContext, storeInteraction } from '../middleware/memory.js'
import { selectModel } from '../router.js'
import { getTracer, SpanStatusCode } from '@sci/telemetry'

interface OpenAIRequest {
  model: string
  messages: OpenRouterMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export async function handleOpenAIChat(
  c: Context,
  adapter: StorageAdapter,
  openrouterKey: string
): Promise<Response> {
  const tracer = getTracer('sci-proxy')
  const body = await c.req.json<OpenAIRequest>()
  const streaming = body.stream !== false

  const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
  const originalUserText = lastUserMsg?.content ?? ''

  const span = tracer.startSpan('sci.llm.request', {
    attributes: {
      'llm.model': body.model,
      'llm.routing_mode': 'openrouter',
      'llm.message_count': body.messages.length,
    },
  })
  const endSpan = (status: 'ok' | 'error', err?: unknown) => {
    if (status === 'error' && err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      span.recordException(err as Error)
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end()
  }

  // 1. Anonymize user messages
  let sessionTokenMap = { forward: new Map<string, string>(), reverse: new Map<string, string>() }
  const anonymizedMessages: OpenRouterMessage[] = body.messages.map(m => {
    if (m.role !== 'user') return m
    const result = anonymize(m.content, sessionTokenMap)
    sessionTokenMap = result.tokenMap
    return { ...m, content: result.text }
  })

  // 2. Inject memory context
  // (OpenRouter handler doesn't currently surface the inspector data — it's
  // not consumed by Sci-aware UIs through this path. We just take the
  // updated messages array.)
  const { messages: messagesWithContext } = await injectMemoryContext(anonymizedMessages, adapter)

  // 3. Select model
  const model = selectModel(body.model, originalUserText)

  if (!streaming) {
    const deanonStream = new DeanonymizingStreamV2(sessionTokenMap)
    const chunks: string[] = []
    for await (const delta of streamFromOpenRouter(
      { model, messages: messagesWithContext, max_tokens: body.max_tokens, stream: true },
      openrouterKey
    )) chunks.push(delta)
    deanonStream.push(chunks.join(''))
    const response = deanonStream.end()
    storeInteraction(originalUserText, response, adapter).catch(() => {})
    endSpan('ok')
    return c.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }],
    })
  }

  // 4. Stream
  const deanonStream = new DeanonymizingStreamV2(sessionTokenMap)
  const encoder = new TextEncoder()
  const id = `chatcmpl-${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const send = (delta: string, finishReason: string | null = null) => {
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }],
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }

      try {
        for await (const delta of streamFromOpenRouter(
          { model, messages: messagesWithContext, max_tokens: body.max_tokens, stream: true },
          openrouterKey
        )) {
          const safe = deanonStream.push(delta)
          if (safe) send(safe)
        }

        const final = deanonStream.end()
        if (final) send(final)
        send('', 'stop')
      } catch (err) {
        send(`[proxy error: ${String(err)}]`, 'stop')
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()

      storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => {})
    },
  })

  endSpan('ok')
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Sci-Model': model,
    },
  })
}
