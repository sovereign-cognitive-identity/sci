/**
 * Direct Anthropic forwarding — preserves your claude.ai subscription.
 *
 * In 'direct' mode the proxy:
 *   1. Anonymizes messages
 *   2. Injects memory context
 *   3. Forwards to api.anthropic.com with the ORIGINAL Authorization header
 *   4. Streams back Anthropic SSE, deanonymizes text deltas on the fly
 *   5. Stores interaction to memory
 *
 * No OpenRouter involved. Your subscription usage counts normally.
 * You lose multi-model routing — everything stays on the Claude model requested.
 */

import { resolveReal, resolveRealDirect } from './dns-resolver.js'

const ANTHROPIC_HOSTNAME = 'api.anthropic.com'
const VPN_MODE = process.env['SCI_VPN_MODE'] === 'true'
const TUN_MODE = process.env['SCI_TUN_MODE'] === 'true'

/**
 * In VPN mode: /etc/hosts redirects api.anthropic.com → 127.0.0.1,
 * so we use resolveReal (dns.resolve4, bypasses /etc/hosts) to get real IP.
 *
 * In TUN mode: /etc/resolver/anthropic.com routes DNS to our fake server,
 * so we use resolveRealDirect (queries 8.8.8.8, bypasses /etc/resolver/)
 * to get real IP — avoiding the routing loop through utun.
 */
async function getUpstreamUrl(path: string): Promise<string> {
  if (TUN_MODE) {
    const ip = await resolveRealDirect(ANTHROPIC_HOSTNAME).catch(() => ANTHROPIC_HOSTNAME)
    return `https://${ip}${path}`
  }
  if (VPN_MODE) {
    const ip = await resolveReal(ANTHROPIC_HOSTNAME).catch(() => ANTHROPIC_HOSTNAME)
    return `https://${ip}${path}`
  }
  return `https://${ANTHROPIC_HOSTNAME}${path}`
}

/** Async generator of text deltas from a direct Anthropic SSE stream. */
export async function* streamFromAnthropic(
  path: string,
  body: unknown,
  originalHeaders: Record<string, string>
): AsyncGenerator<string> {
  const upstreamUrl = await getUpstreamUrl(path)

  // Forward with the original auth — subscription usage preserved
  const response = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      ...originalHeaders,
      'content-type': 'application/json',
      'host': ANTHROPIC_HOSTNAME,  // always send original hostname, not IP
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic ${response.status}: ${err}`)
  }

  if (!response.body) throw new Error('No response body from Anthropic')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (trimmed.startsWith('data: ')) {
        const json = trimmed.slice(6)
        if (json === '[DONE]') return
        try {
          const chunk = JSON.parse(json) as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          // Anthropic SSE: content_block_delta with text_delta
          if (chunk.type === 'content_block_delta' &&
              chunk.delta?.type === 'text_delta' &&
              chunk.delta.text) {
            yield chunk.delta.text
          }
        } catch { /* skip malformed */ }
      }
    }
  }
}

/** Re-stream a direct Anthropic response as Anthropic SSE with deanonymization. */
export async function streamDirectAnthropic(
  path: string,
  requestBody: unknown,
  originalHeaders: Record<string, string>,
  deanonPush: (text: string) => string,
  deanonEnd: () => string,
  onComplete: () => void
): Promise<ReadableStream> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      const msgId = `msg_${Date.now()}`

      const emit = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        )
      }

      emit('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', content: [], stop_reason: null },
      })
      emit('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      })

      try {
        for await (const delta of streamFromAnthropic(path, requestBody, originalHeaders)) {
          const safe = deanonPush(delta)
          if (safe) {
            emit('content_block_delta', {
              type: 'content_block_delta', index: 0,
              delta: { type: 'text_delta', text: safe },
            })
          }
        }

        const final = deanonEnd()
        if (final) {
          emit('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text: final },
          })
        }
      } catch (err) {
        emit('error', { type: 'error', error: { type: 'api_error', message: String(err) } })
      }

      emit('content_block_stop', { type: 'content_block_stop', index: 0 })
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      })
      emit('message_stop', { type: 'message_stop' })
      controller.close()

      onComplete()
    },
  })
}
