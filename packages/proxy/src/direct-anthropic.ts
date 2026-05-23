/**
 * Direct Anthropic forwarding — preserves your claude.ai subscription.
 *
 * In 'direct' mode the proxy:
 *   1. Anonymizes messages
 *   2. Injects memory context
 *   3. Forwards to api.anthropic.com with the ORIGINAL Authorization header
 *   4. Streams back Anthropic SSE verbatim, patching only text_delta events
 *      to deanonymize
 *   5. Stores interaction to memory
 *
 * No OpenRouter involved. Your subscription usage counts normally.
 * You lose multi-model routing — everything stays on the Claude model requested.
 */

import https from 'https'
import http2 from 'http2'
import type { IncomingMessage } from 'http'
import { resolveRealDirect } from './dns-resolver.js'
import { getPhysicalInterfaceIP } from './physical-iface.js'

const ANTHROPIC_HOSTNAME = 'api.anthropic.com'

// Persistent HTTP/2 client session. Anthropic rate-limits HTTP/1.1 proxy
// requests (429) but not HTTP/2 — same behavior as direct Claude Code.
// Exported so passthroughForward() (agent) can share the same session for
// init requests, keeping all traffic on one connection.
let _h2Client: http2.ClientHttp2Session | null = null

export function getH2Client(): http2.ClientHttp2Session {
  if (_h2Client && !_h2Client.destroyed && !_h2Client.closed) return _h2Client
  _h2Client = http2.connect(`https://${ANTHROPIC_HOSTNAME}`)
  _h2Client.on('error', () => { _h2Client = null })
  _h2Client.on('close', () => { _h2Client = null })
  return _h2Client
}

interface H2Response {
  status: number
  stream: http2.ClientHttp2Stream
  firstChunk?: Buffer
}

function makeH2Request(
  path: string,
  h1Headers: Record<string, string | string[] | undefined>,
  bodyStr: string,
): Promise<H2Response> {
  return new Promise((resolve, reject) => {
    const client = getH2Client()
    const h2Req: Record<string, string> = {
      ':method': 'POST',
      ':path': path,
      ':scheme': 'https',
      ':authority': ANTHROPIC_HOSTNAME,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyStr).toString(),
    }
    // Forward all client headers verbatim (minus HTTP/2 pseudo-headers and
    // hop-by-hop). Previous oat01-detection stripping was a workaround for a
    // now-removed auth-swap that put requests on sci's rate-limited OAuth
    // identity; with passthrough auth the client's own betas/fields are
    // exactly what Anthropic expects.
    const skip = new Set([
      ':method', ':path', ':scheme', ':authority',
      'host', 'connection', 'transfer-encoding', 'content-length',
      'content-type', 'accept-encoding',
    ])
    for (const [k, v] of Object.entries(h1Headers)) {
      const lk = k.toLowerCase()
      if (skip.has(lk)) continue
      if (v === undefined) continue
      h2Req[lk] = String(v)
    }
    h2Req['accept-encoding'] = 'identity'

    const req = client.request(h2Req, { endStream: false })
    let status = 200
    let resolved = false
    req.on('response', headers => {
      status = Number(headers[':status'] ?? 200)
      if (!resolved) { resolved = true; resolve({ status, stream: req }) }
    })
    req.on('error', reject)
    // Fallbacks if the response event was missed (rare, but observed under
    // some H2 edge cases): resolve on first data or end.
    req.once('data', (chunk: Buffer) => {
      if (!resolved) { resolved = true; resolve({ status, stream: req, firstChunk: chunk }) }
    })
    req.once('end', () => {
      if (!resolved) { resolved = true; resolve({ status, stream: req }) }
    })
    req.write(bodyStr)
    req.end()
  })
}

const VPN_MODE = process.env['SCI_VPN_MODE'] === 'true'
const TUN_MODE = process.env['SCI_TUN_MODE'] === 'true'

/**
 * In VPN/TUN mode we must connect to the REAL IP to avoid routing loops,
 * but we need TLS to validate against the HOSTNAME (not the IP).
 * fetch() can't do this — use https.request() with separate host/servername.
 *
 * Plus: bind to the physical interface's IP (localAddress) so the kernel
 * routes via en0 even when the destination IP has a more-specific route
 * pointing at utun5 (this is what lets us route real AI IPs through the TUN
 * without our own outbound looping back through it).
 *
 * Returns an IncomingMessage (streaming) so the caller can parse SSE.
 */
async function requestViaRealIP(
  path: string,
  body: unknown,
  originalHeaders: Record<string, string>,
): Promise<IncomingMessage> {
  const realIP = await resolveRealDirect(ANTHROPIC_HOSTNAME)
  const localAddress = TUN_MODE ? (getPhysicalInterfaceIP() ?? undefined) : undefined

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const req = https.request({
      host: realIP,                    // TCP: connect to real IP (bypasses /etc/hosts)
      servername: ANTHROPIC_HOSTNAME,  // TLS SNI: validate cert against hostname
      localAddress,                    // Source IP: bypasses TUN route for outbound
      port: 443,
      path,
      method: 'POST',
      headers: {
        ...originalHeaders,
        'content-type': 'application/json',
        'host': ANTHROPIC_HOSTNAME,
        'content-length': Buffer.byteLength(bodyStr),
      },
      rejectUnauthorized: true,
    }, resolve)
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

/** Async generator of text deltas from a direct Anthropic SSE stream. */
export async function* streamFromAnthropic(
  path: string,
  body: unknown,
  originalHeaders: Record<string, string>,
): AsyncGenerator<string> {
  let stream: AsyncIterable<Buffer>

  if (TUN_MODE || VPN_MODE) {
    const res = await requestViaRealIP(path, body, originalHeaders)
    if ((res.statusCode ?? 0) >= 400) {
      const chunks: Buffer[] = []
      for await (const c of res) chunks.push(c as Buffer)
      throw new Error(`Anthropic ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)
    }
    stream = res
  } else {
    const response = await fetch(`https://${ANTHROPIC_HOSTNAME}${path}`, {
      method: 'POST',
      headers: { ...originalHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Anthropic ${response.status}: ${err}`)
    }
    if (!response.body) throw new Error('No response body from Anthropic')
    const reader = response.body.getReader()
    stream = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const { done, value } = await reader.read()
            return done ? { done: true, value: undefined } : { done: false, value: Buffer.from(value) }
          },
        }
      },
    }
  }

  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += decoder.decode(chunk as Buffer, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (trimmed.startsWith('data: ')) {
        const json = trimmed.slice(6)
        if (json === '[DONE]') return
        try {
          const chunkData = JSON.parse(json) as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          if (chunkData.type === 'content_block_delta' &&
              chunkData.delta?.type === 'text_delta' &&
              chunkData.delta.text) {
            yield chunkData.delta.text
          }
        } catch { /* skip malformed */ }
      }
    }
  }
}

/**
 * Re-stream a direct Anthropic response as Anthropic SSE with deanonymization.
 *
 * Passes through the raw Anthropic SSE stream verbatim, only patching
 * `content_block_delta` events with `text_delta` type to deanonymize text.
 * All other events (tool_use, input_json_delta, message_start with real IDs,
 * token counts, stop_reason, etc.) are forwarded unchanged.
 *
 * On upstream error (4xx/5xx) returns a Response with the actual HTTP status
 * so the SDK can parse it correctly. The SDK chokes on `event: error` carried
 * inside an HTTP 200 body.
 *
 * `extra.prelude` is emitted BEFORE the first Anthropic event.
 * `extra.postlude` is emitted AFTER message_stop.
 */
export async function streamDirectAnthropic(
  path: string,
  requestBody: unknown,
  originalHeaders: Record<string, string>,
  deanonPush: (text: string) => string | undefined,
  deanonEnd: () => string | undefined,
  onComplete: () => void,
  extra?: { prelude?: string; postlude?: () => string },
): Promise<ReadableStream | Response> {
  const encoder = new TextEncoder()

  // Fetch from Anthropic BEFORE creating the ReadableStream so we can return
  // the correct HTTP status code for errors (rate_limit, auth, etc.).
  let asyncStream: AsyncIterable<Buffer>

  if (TUN_MODE || VPN_MODE) {
    asyncStream = await requestViaRealIP(path, requestBody, originalHeaders) as unknown as AsyncIterable<Buffer>
  } else {
    const bodyStr = JSON.stringify(requestBody)
    const { status, stream, firstChunk } = await makeH2Request(path, originalHeaders, bodyStr)
    if (status >= 400) {
      const chunks: Buffer[] = firstChunk ? [firstChunk] : []
      for await (const c of stream) chunks.push(c as Buffer)
      const errText = Buffer.concat(chunks).toString('utf8')
      onComplete()
      return new Response(errText, {
        status,
        headers: { 'content-type': 'application/json', 'x-sci-error': 'upstream' },
      })
    }
    asyncStream = (async function* () {
      if (firstChunk) yield firstChunk
      for await (const chunk of stream) yield chunk as Buffer
    })()
  }

  return new ReadableStream({
    async start(controller) {
      if (extra?.prelude) {
        controller.enqueue(encoder.encode(extra.prelude))
      }
      try {
        // SSE events are separated by \n\n. Parse, forward verbatim, only
        // patch text_delta events to swap anonymized tokens back.
        const decoder = new TextDecoder()
        let buf = ''
        for await (const chunk of asyncStream) {
          buf += decoder.decode(chunk as Buffer, { stream: true })
          const events = buf.split('\n\n')
          buf = events.pop() ?? ''
          for (const rawEvent of events) {
            if (!rawEvent.trim()) continue
            let eventType = ''
            let dataStr = ''
            for (const line of rawEvent.split('\n')) {
              if (line.startsWith('event: ')) eventType = line.slice(7)
              else if (line.startsWith('data: ')) dataStr = line.slice(6)
            }
            if (!dataStr || dataStr === '[DONE]') {
              controller.enqueue(encoder.encode(rawEvent + '\n\n'))
              continue
            }
            try {
              const data = JSON.parse(dataStr) as {
                type?: string
                delta?: { type?: string; text?: string }
              }
              if (data.type === 'content_block_delta' &&
                  data.delta?.type === 'text_delta' &&
                  typeof data.delta.text === 'string') {
                const deanon = deanonPush(data.delta.text)
                data.delta.text = deanon ?? data.delta.text
                const patched = (eventType ? `event: ${eventType}\n` : '') +
                  `data: ${JSON.stringify(data)}\n\n`
                controller.enqueue(encoder.encode(patched))
              } else {
                controller.enqueue(encoder.encode(rawEvent + '\n\n'))
              }
            } catch {
              controller.enqueue(encoder.encode(rawEvent + '\n\n'))
            }
          }
        }
        deanonEnd()
      } catch (err) {
        controller.enqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } })}\n\n`,
        ))
      }
      if (extra?.postlude) {
        const post = extra.postlude()
        if (post) controller.enqueue(encoder.encode(post))
      }
      controller.close()
      onComplete()
    },
  })
}
