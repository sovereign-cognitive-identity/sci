/**
 * HTTPS server for VPN mode.
 *
 * Listens on port 8443. With pf redirect rules, port 443 traffic to
 * 127.0.0.1 gets forwarded here transparently.
 *
 * SNI: when api.anthropic.com connects, we generate a cert for that
 * hostname signed by our local CA (which the OS trusts), complete
 * the TLS handshake, decrypt the traffic, process it, and forward
 * to the real upstream IP (bypassing our /etc/hosts redirect).
 */
import https from 'https'
import type { IncomingMessage, ServerResponse } from 'http'
import type { StorageAdapter } from '@sci/core'
import { ensureCACert, makeSNICallback } from './tls.js'
import { resolveReal } from './dns-resolver.js'
import { handleAnthropicMessages } from './handlers/anthropic.js'
import { handleOpenAIChat } from './handlers/openai.js'

export const VPN_PORT = parseInt(process.env['SCI_VPN_PORT'] ?? '8443')

// Known AI endpoints → their API format
const ENDPOINT_FORMAT: Record<string, 'anthropic' | 'openai'> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'openrouter.ai': 'openai',
  'generativelanguage.googleapis.com': 'openai',
}

export function startHTTPSServer(
  adapter: StorageAdapter,
  openrouterKey: string
): https.Server {
  const ca = ensureCACert()

  // Minimal Hono-compatible context adapter for our handlers
  const makeContext = (req: IncomingMessage, body: Buffer, hostname: string) => ({
    req: {
      json: () => JSON.parse(body.toString()),
      header: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
    },
    json: (data: unknown) => ({ _json: data }),
  })

  const server = https.createServer(
    { SNICallback: makeSNICallback(ca) },
    async (req: IncomingMessage, res: ServerResponse) => {
      const hostname = req.headers.host?.split(':')[0] ?? ''
      const format = ENDPOINT_FORMAT[hostname] ?? 'openai'

      const isAnthropicMessages = format === 'anthropic' && req.url === '/v1/messages'
      const isOpenAIChat = format === 'openai' && (req.url?.startsWith('/v1/chat') ?? false)
      const shouldIntercept = isAnthropicMessages || isOpenAIChat

      if (!shouldIntercept) {
        // Pass through immediately — pipe without buffering so auth flows,
        // streaming responses, and WebSocket upgrades don't hang.
        const realIP = await resolveReal(hostname).catch(() => hostname)
        forwardPipe(req, hostname, realIP, res)
        return
      }

      // Intercepted path — collect body (bounded JSON payload), then process
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)

      try {
        const ctx = makeContext(req, body, hostname)
        const result = isAnthropicMessages
          ? await handleAnthropicMessages(ctx as never, adapter, openrouterKey)
          : await handleOpenAIChat(ctx as never, adapter, openrouterKey)
        await pipeResponse(result, res)
      } catch (err) {
        process.stderr.write(`[vpn] handler error: ${err}\n`)
        if (!res.headersSent) res.writeHead(502)
        res.end(JSON.stringify({ error: String(err) }))
      }
    }
  )

  server.listen(VPN_PORT, '127.0.0.1', () => {
    console.log(`[vpn] HTTPS proxy listening on 127.0.0.1:${VPN_PORT}`)
  })

  return server
}

/**
 * Pipe a request directly to the real upstream without buffering.
 * Used for all non-intercepted paths (auth flows, streaming, WebSocket, etc.)
 * so they never hang waiting for body collection.
 */
function forwardPipe(
  req: IncomingMessage,
  hostname: string,
  realIP: string,
  res: ServerResponse
): void {
  const forwardHeaders: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) forwardHeaders[k] = v
  }
  forwardHeaders['host'] = hostname

  const proxyReq = https.request({
    host: realIP,
    servername: hostname,
    port: 443,
    path: req.url ?? '/',
    method: req.method ?? 'GET',
    headers: forwardHeaders,
    rejectUnauthorized: true,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers as Record<string, string>)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', (err) => {
    process.stderr.write(`[vpn] pipe error ${hostname}: ${err.message}\n`)
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })

  req.pipe(proxyReq)  // stream body directly, no buffering
}

// Headers that must not be forwarded to the upstream
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
])

/**
 * Forward a request to the real upstream server by IP, bypassing /etc/hosts.
 *
 * Uses https.request with explicit `host` (IP) and `servername` (hostname)
 * so TLS SNI uses the original hostname while the TCP connection goes to the
 * real IP — avoiding the /etc/hosts loop and passing TLS cert validation.
 */
function forwardToUpstream(
  req: IncomingMessage,
  body: Buffer,
  hostname: string,
  realIP: string,
  res: ServerResponse
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Strip hop-by-hop headers; keep all others
    const forwardHeaders: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) {
        forwardHeaders[k] = v
      }
    }
    forwardHeaders['host'] = hostname

    const proxyReq = https.request({
      host: realIP,         // TCP: connect to real IP (bypasses /etc/hosts)
      servername: hostname, // TLS SNI: validate cert against original hostname
      port: 443,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: forwardHeaders,
      rejectUnauthorized: true,
    }, (proxyRes) => {
      // Stream response back without buffering
      const responseHeaders: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v !== undefined) responseHeaders[k] = v
      }
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders)
      proxyRes.pipe(res)
      proxyRes.on('end', resolve)
      proxyRes.on('error', reject)
    })

    proxyReq.on('error', (err) => {
      process.stderr.write(`[vpn] upstream error ${hostname}: ${err.message}\n`)
      if (!res.headersSent) res.writeHead(502)
      res.end(JSON.stringify({ error: err.message }))
      resolve()
    })

    if (body.length > 0) proxyReq.write(body)
    proxyReq.end()
  })
}

async function pipeResponse(result: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  result.headers.forEach((v, k) => { headers[k] = v })
  res.writeHead(result.status, headers)

  if (result.body) {
    const reader = result.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}
