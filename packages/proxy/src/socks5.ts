/**
 * SOCKS5 server for TUN-mode interception.
 *
 * sing-box intercepts traffic from the fake IP range (198.18.0.0/15) via
 * the utun device. With TLS sniffing enabled, sing-box extracts the domain
 * name from the TLS ClientHello SNI and sends it here as a SOCKS5 CONNECT
 * request with ATYP=0x03 (domain name).
 *
 * For AI hostnames: TLS intercept → anonymize → memory inject → forward.
 * For everything else: direct TCP passthrough.
 *
 * Loop prevention: outbound connections from THIS server use the real
 * hostname (resolved via real DNS), which returns the REAL IP. The real
 * IP is NOT in 198.18.0.0/15, so it is NOT routed through the TUN.
 */

import net from 'net'
import tls from 'tls'
import https from 'https'
import type { StorageAdapter } from '@sci/core'
import { ensureCACert, makeSNICallback, type CertPair } from './tls.js'
import { isAIHostname, lookupByFakeIP } from './fake-ip.js'
import { handleAnthropicMessages } from './handlers/anthropic.js'
import { handleOpenAIChat } from './handlers/openai.js'
import { makeHonoContext } from './connect-context.js'
import { resolveRealDirect } from './dns-resolver.js'

export const SOCKS5_PORT = parseInt(process.env['SCI_SOCKS5_PORT'] ?? '1080')

const SOCKS5_VERSION = 0x05
const SOCKS5_NO_AUTH = 0x00
const SOCKS5_CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

const AI_PATH_HANDLERS: Record<string, 'anthropic' | 'openai'> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'openrouter.ai': 'openai',
  'generativelanguage.googleapis.com': 'openai',
}

// ── Server entry ──────────────────────────────────────────────────────────────

export function startSOCKS5Server(
  adapter: StorageAdapter,
  openrouterKey: string
): net.Server {
  const ca = ensureCACert()

  const server = net.createServer((socket) => {
    socket.on('error', (err) => {
      process.stderr.write(`[socks5] socket error: ${err.message}\n`)
    })
    handleHandshake(socket, ca, adapter, openrouterKey)
  })

  server.listen(SOCKS5_PORT, '127.0.0.1', () => {
    process.stderr.write(`[socks5] Listening on 127.0.0.1:${SOCKS5_PORT}\n`)
  })

  server.on('error', (err) => {
    process.stderr.write(`[socks5] server error: ${err.message}\n`)
  })

  return server
}

// ── SOCKS5 handshake ──────────────────────────────────────────────────────────

function handleHandshake(
  socket: net.Socket,
  ca: CertPair,
  adapter: StorageAdapter,
  openrouterKey: string
): void {
  socket.once('data', (buf) => {
    // VER(1) NMETHODS(1) METHODS(n)
    if (buf[0] !== SOCKS5_VERSION || buf.length < 2) {
      socket.destroy()
      return
    }

    // Respond: version 5, no auth required
    socket.write(Buffer.from([SOCKS5_VERSION, SOCKS5_NO_AUTH]))

    // Wait for CONNECT request
    socket.once('data', (req) => {
      parseConnect(req, socket, ca, adapter, openrouterKey)
    })
  })
}

function parseConnect(
  req: Buffer,
  socket: net.Socket,
  ca: CertPair,
  adapter: StorageAdapter,
  openrouterKey: string
): void {
  // VER(1) CMD(1) RSV(1) ATYP(1) DST.ADDR DST.PORT(2)
  if (req.length < 7 || req[0] !== SOCKS5_VERSION || req[1] !== SOCKS5_CMD_CONNECT) {
    socket.write(Buffer.from([SOCKS5_VERSION, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    socket.destroy()
    return
  }

  const atyp = req[3]!
  let hostname: string
  let port: number
  let headerEnd: number  // byte offset where the CONNECT header ends

  if (atyp === ATYP_DOMAIN) {
    const len = req[4]!
    hostname = req.slice(5, 5 + len).toString('ascii')
    port = req.readUInt16BE(5 + len)
    headerEnd = 5 + len + 2
  } else if (atyp === ATYP_IPV4) {
    hostname = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`
    port = req.readUInt16BE(8)
    headerEnd = 10
    // Reverse-map fake IP to real hostname if possible
    const mapped = lookupByFakeIP(hostname)
    if (mapped) hostname = mapped
  } else if (atyp === ATYP_IPV6) {
    const ipv6 = Array.from({ length: 8 }, (_, i) =>
      req.readUInt16BE(4 + i * 2).toString(16)
    ).join(':')
    hostname = `[${ipv6}]`
    port = req.readUInt16BE(20)
    headerEnd = 22
  } else {
    socket.write(Buffer.from([SOCKS5_VERSION, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    socket.destroy()
    return
  }

  // SOCKS5 success response
  socket.write(Buffer.from([SOCKS5_VERSION, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))

  // The TLS ClientHello may have arrived in the same TCP segment as the CONNECT
  // request. Any bytes after the CONNECT header must be pushed back onto the
  // socket so the TLS layer sees them — otherwise the handshake waits forever.
  const tail = req.length > headerEnd ? req.slice(headerEnd) : null
  if (tail?.length) {
    process.stderr.write(`[socks5] ${tail.length} bytes piggy-backed with CONNECT, unshifting\n`)
    socket.unshift(tail)
  }

  if (isAIHostname(hostname) && port === 443) {
    process.stderr.write(`[socks5] intercept ${hostname}:${port}\n`)
    interceptTLS(socket, hostname, ca, adapter, openrouterKey)
  } else {
    process.stderr.write(`[socks5] passthrough ${hostname}:${port}\n`)
    directTunnel(socket, hostname, port)
  }
}

// ── TLS interception (for AI endpoints) ──────────────────────────────────────

function interceptTLS(
  clientSocket: net.Socket,
  hostname: string,
  ca: CertPair,
  adapter: StorageAdapter,
  openrouterKey: string
): void {
  // Use tls.createServer + socket injection — more robust than tls.TLSSocket wrapping.
  // The server properly handles socket resume/pause and handshake timing.
  const sniCallback = makeSNICallback(ca)

  const tlsServer = tls.createServer({
    SNICallback: sniCallback,
    ALPNProtocols: ['http/1.1'],
  })

  tlsServer.on('secureConnection', (tlsSocket: tls.TLSSocket) => {
    process.stderr.write(`[socks5] TLS ok ${hostname} proto=${tlsSocket.getProtocol()} alpn=${tlsSocket.alpnProtocol ?? 'none'}\n`)

    let buf = Buffer.alloc(0)
    let headersParsed = false
    let firstChunk = true

    tlsSocket.on('data', (chunk: Buffer) => {
      if (firstChunk) {
        firstChunk = false
        // Log full request line (up to first \r\n)
        const requestLine = chunk.toString('utf-8').split('\r\n')[0] ?? ''
        process.stderr.write(`[socks5] ${hostname} → ${requestLine}\n`)
      }
      buf = Buffer.concat([buf, chunk])
      if (headersParsed) return

      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      headersParsed = true
      const headerStr = buf.slice(0, headerEnd).toString('utf-8')
      const body = buf.slice(headerEnd + 4)
      handleDecryptedRequest(hostname, headerStr, body, tlsSocket, adapter, openrouterKey)
    })

    tlsSocket.on('error', (err) => {
      process.stderr.write(`[socks5] TLS error for ${hostname}: ${err.message}\n`)
    })
  })

  tlsServer.on('tlsClientError', (err) => {
    process.stderr.write(`[socks5] TLS client error ${hostname}: ${err.message}\n`)
  })

  // Inject the raw socket — the TLS server handles it from here
  tlsServer.emit('connection', clientSocket)
  clientSocket.resume()
}

async function handleDecryptedRequest(
  hostname: string,
  headerStr: string,
  initialBody: Buffer,
  tlsSocket: tls.TLSSocket,
  adapter: StorageAdapter,
  openrouterKey: string
): Promise<void> {
  const lines = headerStr.split('\r\n')
  const requestLine = lines[0] ?? ''
  const [method, path] = requestLine.split(' ')

  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }

  const contentLength = parseInt(headers['content-length'] ?? '0', 10)
  let bodyBuf = initialBody

  // Collect remaining body if needed
  if (bodyBuf.length < contentLength) {
    await new Promise<void>((resolve) => {
      tlsSocket.on('data', (chunk: Buffer) => {
        bodyBuf = Buffer.concat([bodyBuf, chunk])
        if (bodyBuf.length >= contentLength) resolve()
      })
    })
  }

  let bodyJson: unknown
  try { bodyJson = JSON.parse(bodyBuf.toString('utf-8')) } catch { bodyJson = {} }

  const ctx = makeHonoContext(method ?? 'POST', path ?? '/', headers, bodyJson)
  const format = AI_PATH_HANDLERS[hostname] ?? 'openai'

  let response: Response
  try {
    if (format === 'anthropic' && path === '/v1/messages') {
      response = await handleAnthropicMessages(ctx as never, adapter, openrouterKey)
    } else if (format === 'openai' && (path?.startsWith('/v1/chat') ?? false)) {
      response = await handleOpenAIChat(ctx as never, adapter, openrouterKey)
    } else {
      // Unknown path — forward to real upstream
      response = await forwardToUpstream(method ?? 'GET', hostname, path ?? '/', headers, bodyBuf)
    }
    await writeResponseToSocket(response, tlsSocket)
  } catch (err) {
    const errBody = JSON.stringify({ error: String(err) })
    tlsSocket.write(
      `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\n\r\n${errBody}`
    )
    tlsSocket.destroy()
  }
}



const TUN_MODE = process.env['SCI_TUN_MODE'] === 'true'

/**
 * Forward to real upstream.
 *
 * In TUN mode: /etc/hosts maps AI hostnames to fake IPs. We must use
 * resolveRealDirect (8.8.8.8) to get the real IP, then https.request with
 * host=realIP + servername=hostname so TLS validates against the hostname.
 * fetch() can't separate TCP host from TLS SNI, so we use https.request.
 */
function forwardToUpstream(
  method: string,
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer
): Promise<Response> {
  if (TUN_MODE) {
    return forwardViaRealIP(method, hostname, path, headers, body)
  }
  return fetch(`https://${hostname}${path}`, {
    method,
    headers: { ...headers, host: hostname },
    body: body.length > 0 ? body : undefined,
    signal: AbortSignal.timeout(30_000),
  })
}

async function forwardViaRealIP(
  method: string,
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer
): Promise<Response> {
  const realIP = await resolveRealDirect(hostname).catch(() => hostname)

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: realIP,           // TCP: connect to real IP (bypasses /etc/hosts)
      servername: hostname,   // TLS SNI: validate cert against original hostname
      port: 443,
      path,
      method,
      headers: { ...headers, host: hostname },
      rejectUnauthorized: true,
    }, async (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const respHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) respHeaders[k] = Array.isArray(v) ? v.join(', ') : v
        }
        resolve(new Response(buf, { status: res.statusCode ?? 502, headers: respHeaders }))
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body.length > 0) req.write(body)
    req.end()
  })
}

async function writeResponseToSocket(
  response: Response,
  socket: tls.TLSSocket
): Promise<void> {
  const statusLine = `HTTP/1.1 ${response.status} ${response.statusText || 'OK'}`
  const headerLines: string[] = [statusLine]
  response.headers.forEach((value, name) => headerLines.push(`${name}: ${value}`))
  headerLines.push('', '')
  socket.write(headerLines.join('\r\n'))

  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      socket.write(value)
    }
  }
  socket.end()
}

// ── Direct passthrough (non-AI endpoints) ─────────────────────────────────────

function directTunnel(clientSocket: net.Socket, hostname: string, port: number): void {
  const upstream = net.connect(port, hostname, () => {
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  upstream.on('error', (err) => {
    process.stderr.write(`[socks5] tunnel error ${hostname}:${port}: ${err.message}\n`)
    clientSocket.destroy()
  })

  clientSocket.on('error', () => upstream.destroy())
  clientSocket.on('close', () => upstream.destroy())
  upstream.on('close', () => clientSocket.destroy())
}
