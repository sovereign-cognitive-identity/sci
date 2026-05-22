#!/usr/bin/env node
/**
 * Sci E2E Health Check
 *
 * Validates the full sci proxy stack is operational:
 *   1. Proxy port is open
 *   2. Real /v1/messages request succeeds (SSE stream with message_start)
 *   3. Memory DB has > 0 records in vector_map (embeddings working)
 *   4. sci MCP is registered in ~/.claude.json
 *
 * Usage:
 *   node scripts/sci-health.mjs
 *   npm run health
 *
 * Exit code 0 = all checks pass, 1 = one or more failures.
 */

import { readFileSync, existsSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import net from 'net'

const HOME = homedir()
const PROXY_PORT = parseInt(process.env['SCI_PROXY_PORT'] ?? '8080')
const PROXY_HOST = 'localhost'
const ANTHROPIC_HOST = 'api.anthropic.com'
const OAUTH_FILE = join(HOME, '.sci', 'oauth.json')
const CA_FILE = join(HOME, '.sci', 'ca.crt')
const DB_FILE = join(HOME, '.sci', 'memory', 'sci.db')
const CLAUDE_JSON = join(HOME, '.claude.json')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const NC = '\x1b[0m'

const results = []

function checkPass(label, detail = '') {
  const suffix = detail ? `  ${YELLOW}(${detail})${NC}` : ''
  console.log(`  ${GREEN}✓${NC} ${label}${suffix}`)
  results.push({ ok: true, label })
}

function checkFail(label, reason = '') {
  console.log(`  ${RED}✗${NC} ${label}`)
  if (reason) console.log(`    ${YELLOW}→${NC} ${reason}`)
  results.push({ ok: false, label, reason })
}

function checkSkip(label, reason = '') {
  console.log(`  ${YELLOW}~${NC} ${label} — ${reason}`)
  results.push({ ok: true, label }) // skipped checks are non-fatal
}

// ── Utility: check TCP port open ─────────────────────────────────────────────

function isPortOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => { sock.destroy(); resolve(false) })
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.connect(port, host)
  })
}

// ── Utility: send HTTPS request through proxy via curl ────────────────────────

function curlThroughProxy(url, headers, body, timeoutSecs = 15) {
  const args = [
    '-s', '--max-time', String(timeoutSecs),
    '--proxy', `http://${PROXY_HOST}:${PROXY_PORT}`,
    '-w', '\n|||STATUS:%{http_code}',
  ]

  if (existsSync(CA_FILE)) {
    args.push('--cacert', CA_FILE)
  } else {
    args.push('-k')
  }

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`)
  }

  if (body) {
    args.push('-X', 'POST', '-d', JSON.stringify(body),
              '-H', 'Content-Type: application/json')
  }

  args.push(url)

  const result = spawnSync('curl', args, { encoding: 'utf8', timeout: (timeoutSecs + 2) * 1000 })
  if (result.error) throw new Error(`curl error: ${result.error.message}`)

  const output = result.stdout ?? ''
  const statusMatch = output.match(/\|\|\|STATUS:(\d+)$/)
  const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0
  const body_out = output.replace(/\|\|\|STATUS:\d+$/, '').trim()

  return { statusCode, body: body_out }
}

// ── Utility: parse SSE body for event names ───────────────────────────────────

function parseSSEEvents(body) {
  const events = []
  const lines = body.split('\n')
  let currentEvent = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event: ')) {
      currentEvent = trimmed.slice(7).trim()
    } else if (trimmed === '' && currentEvent !== null) {
      events.push(currentEvent)
      currentEvent = null
    }
  }
  return events
}

// ── Run all checks ────────────────────────────────────────────────────────────

console.log(`\n── Sci E2E Health Check`)
console.log(`   Proxy: ${PROXY_HOST}:${PROXY_PORT}`)
console.log(`   Time: ${new Date().toISOString()}`)
console.log()

// ── Check 1: Proxy port open ─────────────────────────────────────────────────

const portOpen = await isPortOpen(PROXY_HOST, PROXY_PORT)
if (portOpen) {
  checkPass(`Proxy listening on :${PROXY_PORT}`)
} else {
  checkFail(`Proxy listening on :${PROXY_PORT}`, `No process on ${PROXY_PORT} — is sci-agent running?`)
}

// ── Check 2: API connectivity via proxy (SSE stream with message_start) ───────

let oauthData = null
if (existsSync(OAUTH_FILE)) {
  try {
    oauthData = JSON.parse(readFileSync(OAUTH_FILE, 'utf8'))
  } catch (err) {
    checkFail('OAuth token readable', `Parse error: ${err.message}`)
  }
}

if (!oauthData?.access_token) {
  checkFail('API connectivity (HTTP/2, 200 OK)', 'No OAuth token — cannot authenticate')
} else if (!portOpen) {
  checkFail('API connectivity (HTTP/2, 200 OK)', 'Proxy not running — skipping API test')
} else {
  try {
    const headers = {
      'authorization': `Bearer ${oauthData.access_token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    }

    // Minimal request — one token, low cost
    const requestBody = {
      model: 'claude-haiku-4-5',
      max_tokens: 5,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const response = curlThroughProxy(
      `https://${ANTHROPIC_HOST}/v1/messages`,
      headers,
      requestBody,
      20
    )

    if (response.statusCode === 200) {
      const events = parseSSEEvents(response.body)
      const hasMessageStart = events.includes('message_start')

      if (hasMessageStart) {
        checkPass(`API connectivity (HTTP/2, 200 OK)`, `SSE events: ${events.join(', ')}`)
      } else {
        checkFail(
          'API connectivity (HTTP/2, 200 OK)',
          `Response 200 but no message_start event — got: ${response.body.slice(0, 200)}`
        )
      }
    } else if (response.statusCode === 429) {
      checkSkip('API connectivity (HTTP/2, 200 OK)', `Rate limited (429) — try again later`)
    } else if (response.statusCode === 0) {
      checkFail('API connectivity (HTTP/2, 200 OK)', 'curl failed — proxy may not support CONNECT tunneling')
    } else {
      checkFail(
        'API connectivity (HTTP/2, 200 OK)',
        `HTTP ${response.statusCode}: ${response.body.slice(0, 200)}`
      )
    }
  } catch (err) {
    checkFail('API connectivity (HTTP/2, 200 OK)', err.message)
  }
}

// ── Check 3: Memory DB has > 0 embedded records ───────────────────────────────

if (!existsSync(DB_FILE)) {
  checkFail('Memory store has embedded records', `DB not found at ${DB_FILE}`)
} else {
  try {
    const { createRequire } = await import('module')
    const _require = createRequire(import.meta.url)
    const Database = _require('better-sqlite3')
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM vector_map').get()
    db.close()

    const count = row?.c ?? 0
    if (count > 0) {
      checkPass(`Memory store has ${count} embedded record${count === 1 ? '' : 's'}`)
    } else {
      checkFail('Memory store has embedded records', 'vector_map is empty — embeddings not working')
    }
  } catch (err) {
    checkFail('Memory store has embedded records', `DB read error: ${err.message}`)
  }
}

// ── Check 4: sci MCP registered in ~/.claude.json ────────────────────────────

if (!existsSync(CLAUDE_JSON)) {
  checkFail('sci MCP registered in Claude Code', `${CLAUDE_JSON} not found`)
} else {
  try {
    const claudeConfig = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))
    const mcpServers = claudeConfig?.mcpServers ?? {}
    const sciEntry = mcpServers['sci']

    if (sciEntry) {
      const cmd = Array.isArray(sciEntry.command)
        ? sciEntry.command.join(' ')
        : (sciEntry.command ?? 'stdio')
      checkPass('sci MCP registered in Claude Code', cmd.slice(0, 60))
    } else {
      const registered = Object.keys(mcpServers)
      checkFail(
        'sci MCP registered in Claude Code',
        `"sci" not in mcpServers — found: [${registered.slice(0, 5).join(', ')}]`
      )
    }
  } catch (err) {
    checkFail('sci MCP registered in Claude Code', `Parse error: ${err.message}`)
  }
}

// ── Check 5: OAuth token not expired ─────────────────────────────────────────

if (oauthData) {
  const nowMs = Date.now()
  const expiresAt = oauthData.expires_at_ms ?? 0
  if (expiresAt === 0) {
    checkFail('OAuth token valid', 'expires_at_ms = 0 — token was force-reset, waiting for refresh')
  } else if (expiresAt > nowMs) {
    const hoursLeft = ((expiresAt - nowMs) / 3_600_000).toFixed(1)
    checkPass('OAuth token valid', `expires in ${hoursLeft}h`)
  } else {
    const agoS = Math.round((nowMs - expiresAt) / 1000)
    checkFail('OAuth token valid', `Expired ${agoS}s ago — sci should auto-refresh`)
  }
} else {
  checkFail('OAuth token valid', `No oauth.json at ${OAUTH_FILE}`)
}

// ── Summary ───────────────────────────────────────────────────────────────────

const allPassed = results.every(r => r.ok)
const failedChecks = results.filter(r => !r.ok)

console.log()
console.log('─'.repeat(50))
console.log()

if (allPassed) {
  console.log(`  ${GREEN}OVERALL: PASS${NC}`)
} else {
  console.log(`  ${RED}OVERALL: FAIL${NC}`)
  console.log()
  for (const f of failedChecks) {
    console.log(`  ${RED}✗${NC} ${f.label}`)
    if (f.reason) console.log(`    ${YELLOW}→${NC} ${f.reason}`)
  }
}

console.log()
process.exit(allPassed ? 0 : 1)
