/**
 * `sci status` — system-wide health dashboard
 * `sci verify` — live proxied request smoke test
 *
 * SCI-254
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'
import http from 'http'
import { spawnSync } from 'child_process'

// ── color helpers ─────────────────────────────────────────────────────────────

const green = (s: string) => `  \x1b[32m✓\x1b[0m  ${s}`
const red   = (s: string) => `  \x1b[31m✗\x1b[0m  ${s}`
const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`

// ── port probe ────────────────────────────────────────────────────────────────

function tcpPing(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host, port })
    const timer = setTimeout(() => { sock.destroy(); resolve(false) }, timeoutMs)
    sock.on('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true) })
    sock.on('error',   () => { clearTimeout(timer); resolve(false) })
  })
}

// ── HTTP GET helper ───────────────────────────────────────────────────────────

function httpGet(url: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

// ── individual checks ─────────────────────────────────────────────────────────

interface Check {
  label: string
  pass: boolean
  detail: string
}

async function checkHelper(): Promise<Check> {
  const label = 'Rust helper'
  const proxyUp = await tcpPing('127.0.0.1', 3001)
  const adminUp = await tcpPing('127.0.0.1', 3002)

  if (!proxyUp && !adminUp) {
    return { label, pass: false, detail: ':3001 :3002 down' }
  }

  // Try to fetch version + memory stats from admin API
  try {
    const res = await httpGet('http://127.0.0.1:3002/sci/status', 3000)
    if (res.status === 200) {
      const data = JSON.parse(res.body) as Record<string, unknown>
      const version = (data['version'] as string | undefined) ?? 'unknown'
      const stats = (data['stats'] as Record<string, number> | undefined) ?? {}
      const episodic = stats['episodic'] ?? 0
      const identity = stats['identity'] ?? 0
      const portStr = [proxyUp && ':3001', adminUp && ':3002'].filter(Boolean).join(' ')
      return { label, pass: true, detail: `${portStr} up (v${version}, ${episodic.toLocaleString()} episodic, ${identity} identity)` }
    }
  } catch {
    // admin API unreachable — partial pass
  }

  const portStr = [proxyUp && ':3001', adminUp && ':3002'].filter(Boolean).join(' ')
  return { label, pass: proxyUp, detail: proxyUp ? `${portStr} up` : `:3002 up, :3001 down (proxy not listening)` }
}

async function checkAgent(): Promise<Check> {
  const label = 'Node agent'
  const up = await tcpPing('127.0.0.1', 8080)
  return { label, pass: up, detail: up ? ':8080 up' : ':8080 down' }
}

function checkMCP(): Check {
  const label = 'MCP server'
  const claudeJson = join(homedir(), '.claude.json')
  try {
    const raw = readFileSync(claudeJson, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const servers = data['mcpServers'] as Record<string, unknown> | undefined
    if (servers && 'sci' in servers) {
      return { label, pass: true, detail: `registered in ${dim('~/.claude.json')}` }
    }
    return { label, pass: false, detail: `'sci' key missing from ${dim('~/.claude.json')}` }
  } catch {
    return { label, pass: false, detail: `${dim('~/.claude.json')} not found or invalid` }
  }
}

function checkCA(): Check {
  const label = 'CA certificate'
  const caCert = join(homedir(), '.sci', 'ca.crt')
  const helperCa = join(homedir(), '.sci', 'helper-ca', 'ca.crt')

  if (!existsSync(caCert)) {
    return { label, pass: false, detail: `missing at ${dim('~/.sci/ca.crt')}` }
  }

  // Optionally check System Keychain (macOS only, best-effort)
  const res = spawnSync('security', [
    'find-certificate', '-c', 'Sci', '/Library/Keychains/System.keychain',
  ], { encoding: 'utf-8' })

  const trusted = res.status === 0
  const helperNote = existsSync(helperCa) ? ' + helper CA' : ''
  return {
    label,
    pass: true,
    detail: `present${helperNote}${trusted ? ', trusted in keychain' : ' (not yet trusted in keychain — run install.sh)'}`,
  }
}

function checkCredentials(): Check {
  const label = 'Credentials'
  const credsFile = join(homedir(), '.sci', 'credentials.env')

  // Check env first
  if (process.env['ANTHROPIC_API_KEY']) {
    return { label, pass: true, detail: 'ANTHROPIC_API_KEY set (env)' }
  }

  if (!existsSync(credsFile)) {
    return { label, pass: false, detail: `${dim('~/.sci/credentials.env')} not found` }
  }

  const content = readFileSync(credsFile, 'utf-8')
  const lines = content.split('\n')
  const hasKey = lines.some(l => l.match(/^ANTHROPIC_API_KEY\s*=\s*.+/))

  if (hasKey) {
    return { label, pass: true, detail: `ANTHROPIC_API_KEY set in ${dim('~/.sci/credentials.env')}` }
  }
  return { label, pass: false, detail: `ANTHROPIC_API_KEY not set in ${dim('~/.sci/credentials.env')}` }
}

function checkProxy(): Check {
  const label = 'Proxy config'
  const settingsPath = join(homedir(), '.claude', 'settings.json')

  if (!existsSync(settingsPath)) {
    return { label, pass: false, detail: `${dim('~/.claude/settings.json')} not found` }
  }

  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const env = data['env'] as Record<string, string> | undefined
    if (env?.['HTTPS_PROXY']) {
      return { label, pass: true, detail: `${dim('~/.claude/settings.json')} env ✓ (${env['HTTPS_PROXY']})` }
    }
    return { label, pass: false, detail: `HTTPS_PROXY not set in ${dim('~/.claude/settings.json')} env` }
  } catch {
    return { label, pass: false, detail: `${dim('~/.claude/settings.json')} unreadable` }
  }
}

// ── sci status ────────────────────────────────────────────────────────────────

export async function runStatus(): Promise<void> {
  console.log('\nSci status')
  console.log('─'.repeat(50))

  const checks = await Promise.all([
    checkHelper(),
    checkAgent(),
    Promise.resolve(checkMCP()),
    Promise.resolve(checkCA()),
    Promise.resolve(checkCredentials()),
    Promise.resolve(checkProxy()),
  ])

  let anyFailed = false
  for (const c of checks) {
    const line = c.pass ? green(c.label.padEnd(18) + c.detail)
                        : red(c.label.padEnd(18) + c.detail)
    console.log(line)
    if (!c.pass) anyFailed = true
  }

  console.log()
  if (!anyFailed) {
    console.log('  \x1b[32mAll systems operational.\x1b[0m\n')
    process.exit(0)
  } else {
    console.log('  \x1b[31mSome checks failed — see above.\x1b[0m\n')
    process.exit(1)
  }
}

// ── sci verify ────────────────────────────────────────────────────────────────

export async function runVerify(): Promise<void> {
  console.log('\nSci verify — live proxy smoke test')
  console.log('─'.repeat(50))

  // Step 1: pick the proxy port (prefer :3001, fallback :8080)
  const helper3001 = await tcpPing('127.0.0.1', 3001)
  const agent8080  = await tcpPing('127.0.0.1', 8080)

  let proxyPort: number | null = null
  if (helper3001) {
    proxyPort = 3001
    console.log(green(`Using Rust helper proxy on :3001`))
  } else if (agent8080) {
    proxyPort = 8080
    console.log(green(`Using Node agent proxy on :8080 (fallback — :3001 not up)`))
  } else {
    console.log(red('No proxy listening on :3001 or :8080'))
    console.log('\n  FAIL — start the Sci services first: launchctl kickstart gui/$(id -u)/dev.sci.helper\n')
    process.exit(1)
  }

  // Step 2: fetch a user identity fact (best-effort) for display
  let userName = 'unknown'
  try {
    const res = await httpGet(`http://127.0.0.1:3002/sci/identity?limit=1`, 2000)
    if (res.status === 200) {
      const data = JSON.parse(res.body) as { facts?: Array<{ content: string }> }
      const first = data.facts?.[0]?.content ?? ''
      const nameMatch = first.match(/^(\w+)\s/)
      if (nameMatch) userName = nameMatch[1]!
    }
  } catch {
    // admin API not available — continue anyway
  }

  // Step 3: make a test API call through the proxy
  // We send a minimal Anthropic messages request through the proxy and confirm
  // the proxy intercepts it (200 or proxied error are both success for this check).
  // Full anonymization audit via proxy log is a future enhancement.

  const credsFile = join(homedir(), '.sci', 'credentials.env')
  let apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
  if (!apiKey && existsSync(credsFile)) {
    const creds = readFileSync(credsFile, 'utf-8')
    const match = creds.match(/^ANTHROPIC_API_KEY=(.+)$/m)
    if (match) apiKey = match[1]!.trim()
  }

  // Use the special sci_t_chat_local sentinel if no real key (helper handles it)
  const probeKey = apiKey || 'sci_t_chat_local'

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the single word: VERIFIED' }],
  })

  console.log(`\n  Sending test request through proxy :${proxyPort}...`)
  console.log(dim(`  (user context: ${userName})`))

  const caCert = join(homedir(), '.sci', 'ca-bundle.crt')
  const caFallback = join(homedir(), '.sci', 'ca.crt')
  const caPath = existsSync(caCert) ? caCert : existsSync(caFallback) ? caFallback : null

  // Use curl for the actual proxied request — it's the most reliable way to
  // honor the local CA cert and HTTP_PROXY in a Node.js CLI context.
  const { spawnSync } = await import('child_process')
  const curlArgs: string[] = [
    '-s', '--max-time', '20',
    '--proxy', `http://127.0.0.1:${proxyPort}`,
    '-H', `x-api-key: ${probeKey}`,
    '-H', 'anthropic-version: 2023-06-01',
    '-H', 'content-type: application/json',
    '-d', body,
  ]
  if (caPath) {
    curlArgs.push('--cacert', caPath)
  }
  curlArgs.push('https://api.anthropic.com/v1/messages')

  const result = spawnSync('curl', curlArgs, { encoding: 'utf-8', timeout: 25000 })
  const output = (result.stdout ?? '').trim()

  if (result.error) {
    console.log(red(`curl failed: ${result.error.message}`))
    console.log('\n  FAIL\n')
    process.exit(1)
  }

  // A response reaching us (even an API error) means the proxy is intercepting
  let pass = false
  let detail = ''

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    if (parsed['type'] === 'message') {
      const text = (parsed['content'] as Array<{ text?: string }>)?.[0]?.text ?? ''
      pass = true
      detail = `Response: "${text.slice(0, 60)}"`
    } else if (parsed['type'] === 'error') {
      // Proxy reached Anthropic but got an API error — proxy is working
      pass = true
      detail = `Proxy up; API error: ${(parsed['error'] as Record<string, string>)?.['message']?.slice(0, 60) ?? output.slice(0, 80)}`
    } else {
      // Non-empty response came back through the proxy
      pass = output.length > 0
      detail = output.slice(0, 120)
    }
  } catch {
    pass = output.length > 0
    detail = output.slice(0, 120) || `curl exit ${result.status}`
  }

  console.log()
  if (pass) {
    console.log(green(`Proxy intercept confirmed`))
    console.log(`  ${dim(detail)}`)
    console.log('\n  \x1b[32mPASS\x1b[0m\n')
    process.exit(0)
  } else {
    console.log(red(`No response through proxy`))
    console.log(`  ${dim(detail || 'empty response')}`)
    console.log('\n  \x1b[31mFAIL\x1b[0m\n')
    process.exit(1)
  }
}
