#!/usr/bin/env node
/**
 * Sci Proxy Server
 *
 * Sits between AI clients and providers. Anonymizes outbound requests,
 * injects memory context, routes to the best model, streams back
 * deanonymized responses, and stores interactions to memory.
 *
 * Usage:
 *   SCI_OPENROUTER_KEY=sk-or-... \
 *   SCI_DB_READER_URL=... SCI_DB_WRITER_URL=... \
 *   node packages/proxy/dist/index.js
 *
 * Then set in your AI client:
 *   ANTHROPIC_BASE_URL=http://localhost:3001   (Claude Code)
 *   OPENAI_BASE_URL=http://localhost:3001      (Cursor, Copilot, etc.)
 */
import { execSync } from 'child_process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createStorageAdapter } from '@sci/core'
import { startTelemetry, getTracer, SpanStatusCode } from '@sci/telemetry'

// Must be called before any instrumented code runs
startTelemetry({ service: 'sci-proxy', version: '0.1.0' })
import { handleAnthropicMessages } from './handlers/anthropic.js'
import { handleOpenAIChat } from './handlers/openai.js'
import { startHTTPSServer, VPN_PORT } from './server-https.js'
import { warmDNSCache } from './dns-resolver.js'
import { attachConnectHandler } from './server-connect.js'
import { startWatchdog } from './watchdog.js'
import { startSOCKS5Server } from './socks5.js'
import { startDNSServer } from './dns-server.js'
import { startTUNWithGuard } from './tun.js'
import { warmFakeIPs } from './fake-ip.js'

const PORT = parseInt(process.env['SCI_PROXY_PORT'] ?? '3001')
const VPN_MODE = process.env['SCI_VPN_MODE'] === 'true'
const OPENROUTER_KEY = requireEnv('SCI_OPENROUTER_KEY')

// ── Safety check ──────────────────────────────────────────────────────────────
// CRITICAL: If /etc/hosts has sci-vpn entries and VPN mode is OFF, all AI calls
// will loop back to localhost and fail silently. Detect and warn loudly.
import { readFileSync as _readFileSync } from 'fs'
try {
  const hosts = _readFileSync('/etc/hosts', 'utf-8')
  if (hosts.includes('# BEGIN sci-vpn') && !VPN_MODE) {
    process.stderr.write(`
⚠️  WARNING: /etc/hosts contains sci-vpn redirect entries but SCI_VPN_MODE=false.
   ALL AI API calls will loop back to localhost and FAIL.
   Fix: run 'sci vpn uninstall' or manually remove the # BEGIN sci-vpn block from /etc/hosts
   then flush DNS: dscacheutil -flushcache && killall -HUP mDNSResponder
\n`)
  }
} catch { /* /etc/hosts unreadable — ignore */ }

const adapter = await createStorageAdapter()
const app = new Hono()

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/', (c) => c.json({
  name: 'sci-proxy',
  version: '0.1.0',
  status: 'ok',
  endpoints: ['POST /v1/messages', 'POST /v1/chat/completions'],
}))

app.get('/health', async (c) => {
  const stats = await adapter.getStats()
  return c.json({ ok: true, backend: stats.backend, memories: stats.episodic })
})

// ── Anthropic Messages API ────────────────────────────────────────────────────

app.post('/v1/messages', (c) => {
  const tracer = getTracer('sci-proxy')
  return tracer.startActiveSpan('http.request', (span) => {
    span.setAttributes({
      'http.method': 'POST',
      'http.route': '/v1/messages',
      'http.target': '/v1/messages',
    })
    return handleAnthropicMessages(c, adapter, OPENROUTER_KEY)
      .then((res) => { span.setStatus({ code: SpanStatusCode.OK }); span.end(); return res })
      .catch((err) => { span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) }); span.recordException(err); span.end(); throw err })
  })
})

// ── OpenAI Chat Completions API ───────────────────────────────────────────────

app.post('/v1/chat/completions', (c) => {
  const tracer = getTracer('sci-proxy')
  return tracer.startActiveSpan('http.request', (span) => {
    span.setAttributes({
      'http.method': 'POST',
      'http.route': '/v1/chat/completions',
      'http.target': '/v1/chat/completions',
    })
    return handleOpenAIChat(c, adapter, OPENROUTER_KEY)
      .then((res) => { span.setStatus({ code: SpanStatusCode.OK }); span.end(); return res })
      .catch((err) => { span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) }); span.recordException(err); span.end(); throw err })
  })
})

// ── Models list (pass-through stub) ──────────────────────────────────────────

app.get('/v1/models', (c) => c.json({
  object: 'list',
  data: [
    { id: 'claude-sonnet-4-5', object: 'model' },
    { id: 'claude-haiku-4-5', object: 'model' },
    { id: 'gpt-4o', object: 'model' },
    { id: 'gemini-2.5-flash', object: 'model' },
  ],
}))

// ── Start ─────────────────────────────────────────────────────────────────────

const stats = await adapter.getStats()
const routingMode = process.env['SCI_ROUTING_MODE'] ?? 'direct'

const TUN_MODE = process.env['SCI_TUN_MODE'] === 'true'

if (TUN_MODE) {
  console.log(`\n🛡️  Sci TUN Proxy starting`)
  console.log(`   Storage: ${stats.backend}`)
  console.log(`   Mode: TUN (sing-box + SOCKS5 interception)`)
  console.log(`   Routing: ${routingMode}`)
  console.log()

  warmFakeIPs()

  // Start DNS server (fake IPs for AI domains)
  startDNSServer()

  // Start SOCKS5 server (sing-box forwards intercepted connections here)
  startSOCKS5Server(adapter, OPENROUTER_KEY)

  // Start sing-box + route + guard (includes stale recovery, recovery script, signal handlers)
  try {
    await startTUNWithGuard(adapter)
    console.log(`\n✓ TUN interceptor active. All AI traffic is now anonymized.`)
    console.log(`  Recovery: bash ~/.sci/recover.sh (if anything goes wrong)\n`)
  } catch (err) {
    console.error(`[tun] Failed to start TUN: ${err}`)
    console.error('  Cleaning up...')
    try { execSync(`bash ~/.sci/recover.sh 2>/dev/null || true`, { stdio: 'pipe' }) } catch { /* ignore */ }
    process.exit(1)
  }

} else if (VPN_MODE) {
  // Legacy HTTPS interception mode (kept for reference)
  console.log(`\n🔒 Sci VPN Proxy starting`)
  console.log(`   Storage: ${stats.backend}`)
  console.log(`   Mode: VPN (HTTPS interception on port ${VPN_PORT})`)
  console.log(`   Routing: ${routingMode}`)
  console.log()

  await warmDNSCache()
  startHTTPSServer(adapter, OPENROUTER_KEY)
} else {
  console.log(`\n🔀 Sci Proxy starting on port ${PORT}`)
  console.log(`   Storage: ${stats.backend}`)
  console.log(`   Routing: ${routingMode} ${routingMode === 'direct' ? '(subscription preserved)' : '(OpenRouter)'}`)
  console.log(`\n   Set in Claude Code:`)
  console.log(`   ANTHROPIC_BASE_URL=http://localhost:${PORT}`)
  console.log(`\n   Set in Cursor/OpenAI clients:`)
  console.log(`   OPENAI_BASE_URL=http://localhost:${PORT}`)
  console.log()

  const httpServer = serve({ fetch: app.fetch, port: PORT })

  // Attach HTTP CONNECT handler for system-proxy mode (HTTPS_PROXY=http://localhost:3001)
  const CONNECT_MODE = process.env['SCI_CONNECT_MODE'] !== 'false'
  if (CONNECT_MODE) {
    // @ts-ignore — serve() returns a Node.js http.Server which has .on()
    attachConnectHandler(httpServer as never, adapter, OPENROUTER_KEY)
    console.log(`   HTTP CONNECT: enabled (HTTPS_PROXY=http://localhost:${PORT})`)
  }

  // Start watchdog to auto-revert system proxy if this process dies
  const WATCHDOG_MODE = process.env['SCI_WATCHDOG'] !== 'false'
  if (WATCHDOG_MODE) {
    startWatchdog(PORT)
  }
}

process.on('SIGTERM', async () => { await adapter.disconnect(); process.exit(0) })
process.on('SIGINT', async () => { await adapter.disconnect(); process.exit(0) })

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
