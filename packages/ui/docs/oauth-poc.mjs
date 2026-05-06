#!/usr/bin/env node
/**
 * Standalone OAuth proof-of-concept.
 *
 * Validates the research in oauth-research.md by performing the full PKCE
 * loopback flow with no other Sci dependencies. If this works, the rest of
 * packages/ui can be built on top of it with confidence.
 *
 * Usage:
 *   node oauth-poc.mjs login         # opens browser, runs full flow, prints token
 *   node oauth-poc.mjs refresh       # rotates token using stored refresh_token
 *   node oauth-poc.mjs test [path]   # POSTs a sample request to /v1/messages
 *                                     via http://localhost:3001 (the Sci proxy)
 *                                     using the stored access_token
 *
 * Token cache: ~/.sci/oauth.json
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLIENT_ID    = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'
// Authorize and refresh use DIFFERENT scope sets — copied verbatim from
// claude-code CLI's `hz1` (authorize) and `EH8` (refresh).
//
// `org:create_api_key` is a one-shot scope used during initial auth for the
// API-key-creation flow; it's NOT refresh-eligible. Sending it on refresh
// returns `400 invalid_scope`.
const AUTHORIZE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const REFRESH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

const CACHE_DIR  = join(homedir(), '.sci')
const CACHE_PATH = join(CACHE_DIR, 'oauth.json')

// ── PKCE / state ──────────────────────────────────────────────────────────────

function pkce() {
  // Sizes match Claude Code CLI byte-for-byte:
  //   verifier = base64url(randomBytes(32))   → 43 chars
  //   challenge = base64url(sha256(verifier)) → 43 chars
  //   state    = base64url(randomBytes(32))   → 43 chars  (CLI uses 32, not 16)
  const code_verifier  = crypto.randomBytes(32).toString('base64url')
  const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url')
  const state          = crypto.randomBytes(32).toString('base64url')
  return { code_verifier, code_challenge, state }
}

// ── Token cache ───────────────────────────────────────────────────────────────

function readCache() {
  if (!existsSync(CACHE_PATH)) return null
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) } catch { return null }
}

function writeCache(data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2))
  chmodSync(CACHE_PATH, 0o600)
  console.log(`saved → ${CACHE_PATH}`)
}

// ── OAuth steps ───────────────────────────────────────────────────────────────

async function login() {
  const { code_verifier, code_challenge, state } = pkce()

  // Spin up loopback server first so we know the port.
  // Listen on 127.0.0.1 but advertise the redirect_uri as `localhost`,
  // matching Claude Code CLI's pattern exactly.
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const redirectUri = `http://localhost:${port}/callback`
  console.log(`loopback listener: ${redirectUri}`)

  // Param order and `code=true` flag taken verbatim from claude-code CLI's
  // buildAuthUrl() — both matter for Anthropic's auth server.
  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.append('code',                  'true')
  authUrl.searchParams.append('client_id',             CLIENT_ID)
  authUrl.searchParams.append('response_type',         'code')
  authUrl.searchParams.append('redirect_uri',          redirectUri)
  authUrl.searchParams.append('scope',                 AUTHORIZE_SCOPES.join(' '))
  authUrl.searchParams.append('code_challenge',        code_challenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state',                 state)

  console.log('\nopening browser…')
  console.log('if it does not open, visit:\n')
  console.log(authUrl.toString())
  console.log()
  exec(`open "${authUrl.toString()}"`)

  const codePromise = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404, { Connection: 'close' }); res.end()
        return
      }
      const code         = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error        = url.searchParams.get('error')

      const html = `<!doctype html><html><body style="font-family:system-ui;padding:2rem;">
        <h2>${error ? 'Authorization failed' : 'You can close this tab'}</h2>
        <p>${error ?? ''}</p></body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' })
      res.end(html)

      if (error)                  return reject(new Error(`oauth error: ${error}`))
      if (!code)                  return reject(new Error('callback missing code'))
      if (returnedState !== state) return reject(new Error('state mismatch — possible CSRF'))
      resolve(code)
    })
    setTimeout(() => reject(new Error('timeout waiting for browser auth (300s)')), 300_000)
  })

  let code
  try { code = await codePromise } finally { server.close() }
  console.log('got auth code, exchanging for token…')

  const body = {
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    code,
    redirect_uri:  redirectUri,
    state,
    code_verifier,
  }
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text}`)
  const tok = JSON.parse(text)
  console.log('token response keys:', Object.keys(tok).join(', '))

  const cache = {
    access_token:  tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at_ms: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    scope:         tok.scope,         // what was actually granted (string, space-separated)
    organization:  tok.organization,
    account:       tok.account,
    token_uuid:    tok.token_uuid,
  }
  writeCache(cache)
  console.log('\n✓ login complete — token saved.')
}

async function refresh() {
  const cache = readCache()
  if (!cache?.refresh_token) throw new Error('no refresh_token cached. run `login` first.')
  // Prefer the granted-scope string from the cached token; fall back to the
  // refresh-eligible default. Either way: do NOT send `org:create_api_key` —
  // it's not refresh-eligible and Anthropic returns 400 invalid_scope.
  const scope = cache.scope ?? REFRESH_SCOPES.join(' ')
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      refresh_token: cache.refresh_token,
      scope,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`refresh failed (${res.status}): ${text}`)
  const tok = JSON.parse(text)
  const next = {
    access_token:  tok.access_token,
    refresh_token: tok.refresh_token ?? cache.refresh_token,
    expires_at_ms: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    scope:         tok.scope         ?? cache.scope,
    organization:  tok.organization  ?? cache.organization,
    account:       tok.account       ?? cache.account,
    token_uuid:    tok.token_uuid    ?? cache.token_uuid,
  }
  writeCache(next)
  console.log('✓ refresh complete')
}

async function test(path = '/v1/messages') {
  const cache = readCache()
  if (!cache?.access_token) throw new Error('no access_token cached. run `login` first.')

  const body = {
    model:      'claude-haiku-4-5-20251001',
    messages:   [{ role: 'user', content: 'say POC and nothing else' }],
    max_tokens: 5,
    stream:     false,
  }
  const res = await fetch(`http://localhost:3001${path}`, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${cache.access_token}`,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  console.log(`HTTP ${res.status}`)
  console.log(text.slice(0, 800))
}

// ── Entry point ───────────────────────────────────────────────────────────────

const cmd = process.argv[2]
try {
  if      (cmd === 'login')   await login()
  else if (cmd === 'refresh') await refresh()
  else if (cmd === 'test')    await test(process.argv[3])
  else {
    console.log('usage: node oauth-poc.mjs <login|refresh|test [path]>')
    process.exit(1)
  }
} catch (err) {
  console.error('error:', err.message)
  process.exit(1)
}
