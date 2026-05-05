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

      // Read full body
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)

      try {
        if (format === 'anthropic' && req.url === '/v1/messages') {
          // Route through real upstream using actual IP
          const realIP = await resolveReal(hostname).catch(() => null)
          if (realIP) {
            await forwardToUpstream(req, body, hostname, realIP, res)
          } else {
            // Fall back to handler which will use api.anthropic.com (may loop — handle gracefully)
            const ctx = makeContext(req, body, hostname)
            const result = await handleAnthropicMessages(ctx as never, adapter, openrouterKey)
            await pipeResponse(result, res)
          }
        } else if (format === 'openai' && req.url?.startsWith('/v1/chat')) {
          const ctx = makeContext(req, body, hostname)
          const result = await handleOpenAIChat(ctx as never, adapter, openrouterKey)
          await pipeResponse(result, res)
        } else {
          // Pass through unknown paths
          const realIP = await resolveReal(hostname).catch(() => hostname)
          await forwardToUpstream(req, body, hostname, realIP, res)
        }
      } catch (err) {
        res.writeHead(502)
        res.end(JSON.stringify({ error: String(err) }))
      }
    }
  )

  server.listen(VPN_PORT, '127.0.0.1', () => {
    console.log(`[vpn] HTTPS proxy listening on 127.0.0.1:${VPN_PORT}`)
  })

  return server
}

/** Forward a request to the real upstream server by IP (bypasses /etc/hosts). */
async function forwardToUpstream(
  req: IncomingMessage,
  body: Buffer,
  hostname: string,
  realIP: string,
  res: ServerResponse
): Promise<void> {
  const url = `https://${realIP}${req.url ?? '/'}`

  const upstream = await fetch(url, {
    method: req.method ?? 'GET',
    headers: {
      ...req.headers as Record<string, string>,
      host: hostname,  // send original hostname, not IP
    },
    body: body.length > 0 ? body : undefined,
    // @ts-ignore — Node fetch supports this
    dispatcher: undefined,
  })

  res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
  const text = await upstream.text()
  res.end(text)
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
