/**
 * OAuth client for Claude Pro/Max subscriptions.
 *
 * This module replicates the auth flow Claude Code CLI uses (PKCE + loopback
 * redirect, against Anthropic's `9d1c250a-…` client_id). It produces a Bearer
 * token that bills against the user's subscription instead of API credits when
 * sent to `/v1/messages` with `anthropic-beta: oauth-2025-04-20`.
 *
 * Validated end-to-end on 2026-05-06. See `docs/oauth-research.md` for the
 * details that aren't obvious from a static read of Anthropic's docs (the
 * `code=true` marker, `localhost` vs `127.0.0.1`, the authorize-vs-refresh
 * scope split, the `oauth-2025-04-20` beta header).
 *
 * Public API:
 *   login()           run the full PKCE flow, save token, return TokenInfo
 *   refresh()         rotate access_token via refresh_token
 *   logout()          delete the cached token
 *   getAccessToken()  read cache, refresh if expiring, return access_token
 *   readCache()       read cache without refreshing (may be expired)
 *
 * Token cache: ~/.sci/oauth.json, mode 0600.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID    = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'

/**
 * Header to send on every OAuth-authenticated `/v1/messages` request.
 * Without it Anthropic's API rejects OAuth Bearers as if they were missing API keys.
 */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'

/**
 * Scopes requested at authorize time. Includes `org:create_api_key` even though
 * we don't use it — Anthropic's authorize endpoint validates the requested set
 * against an allowed list per client_id and rejects narrower subsets.
 */
const AUTHORIZE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

/**
 * Refresh-eligible scopes. `org:create_api_key` is one-shot and gets dropped
 * after the initial auth — sending it on refresh returns 400 invalid_scope.
 */
const REFRESH_SCOPES_FALLBACK = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

const CACHE_DIR  = join(homedir(), '.sci')
const CACHE_PATH = join(CACHE_DIR, 'oauth.json')

// Refresh proactively once we're within this many ms of expiry.
const REFRESH_LEEWAY_MS = 60_000

// Browser auth timeout — user has 5 minutes to log in.
const BROWSER_AUTH_TIMEOUT_MS = 300_000

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenInfo {
  access_token: string
  refresh_token: string
  /** Absolute timestamp; null if Anthropic didn't return expires_in. */
  expires_at_ms: number | null
  /** Space-separated scopes Anthropic actually granted. */
  scope: string
  organization: unknown
  account: unknown
  token_uuid?: string
}

interface TokenResponse {
  token_type: string
  access_token: string
  refresh_token: string
  expires_in?: number
  scope: string
  organization?: unknown
  account?: unknown
  token_uuid?: string
}

// ── PKCE / state ──────────────────────────────────────────────────────────────

function pkce() {
  // Sizes chosen to match Claude Code CLI byte-for-byte.
  const code_verifier  = crypto.randomBytes(32).toString('base64url')
  const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url')
  const state          = crypto.randomBytes(32).toString('base64url')
  return { code_verifier, code_challenge, state }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

export function readCache(): TokenInfo | null {
  if (!existsSync(CACHE_PATH)) return null
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as TokenInfo }
  catch { return null }
}

function writeCache(data: TokenInfo): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2))
  chmodSync(CACHE_PATH, 0o600)
}

function tokenInfoFromResponse(tok: TokenResponse, prev?: TokenInfo | null): TokenInfo {
  return {
    access_token:  tok.access_token,
    refresh_token: tok.refresh_token ?? prev?.refresh_token ?? '',
    expires_at_ms: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    scope:         tok.scope ?? prev?.scope ?? '',
    organization:  tok.organization ?? prev?.organization ?? null,
    account:       tok.account ?? prev?.account ?? null,
    token_uuid:    tok.token_uuid ?? prev?.token_uuid,
  }
}

// ── Browser ───────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? `open "${url}"`
            : platform() === 'win32'  ? `start "" "${url}"`
            :                           `xdg-open "${url}"`
  exec(cmd, (err) => { if (err) console.error('failed to open browser:', err.message) })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full PKCE OAuth flow:
 *   1. Spin up a loopback HTTP server on a random port
 *   2. Open the user's browser to Anthropic's authorize URL
 *   3. Wait for redirect with the auth code
 *   4. Exchange code → tokens
 *   5. Save cache
 *
 * @param opts.onAuthUrl  Optional hook called with the authorize URL — useful
 *                        for headless contexts where the caller wants to log
 *                        the URL instead of relying on `open`.
 */
export async function login(opts: { onAuthUrl?: (url: string) => void } = {}): Promise<TokenInfo> {
  const { code_verifier, code_challenge, state } = pkce()

  // Bind on 127.0.0.1 — Chrome routes `localhost` to IPv4 loopback so this is
  // safe, and matches Claude Code CLI's own server bind.
  //
  // Port: random by default, but can be pinned via SCI_OAUTH_LOOPBACK_PORT.
  // Pinning matters for Docker — port mapping needs a known target. Outside
  // Docker, random is best (avoids "address in use" if multiple flows fire).
  // We bind on 0.0.0.0 when a port is pinned so the redirect can come back
  // through Docker's port-mapped network; on random ports we stay on 127.
  const pinnedPort = Number(process.env['SCI_OAUTH_LOOPBACK_PORT'] ?? 0)
  const bindAddr   = pinnedPort > 0 ? '0.0.0.0' : '127.0.0.1'
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pinnedPort, bindAddr, () => resolve())
  })
  const port = (server.address() as { port: number }).port
  // Advertise as `localhost` — Anthropic's auth server matches the redirect_uri
  // string-equally and only `localhost` is whitelisted, not `127.0.0.1`.
  const redirectUri = `http://localhost:${port}/callback`

  // Param order matches Claude Code CLI's buildAuthUrl() — `code=true` first
  // is non-standard but Anthropic-required.
  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.append('code',                  'true')
  authUrl.searchParams.append('client_id',             CLIENT_ID)
  authUrl.searchParams.append('response_type',         'code')
  authUrl.searchParams.append('redirect_uri',          redirectUri)
  authUrl.searchParams.append('scope',                 AUTHORIZE_SCOPES.join(' '))
  authUrl.searchParams.append('code_challenge',        code_challenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state',                 state)

  if (opts.onAuthUrl) opts.onAuthUrl(authUrl.toString())
  openBrowser(authUrl.toString())

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404, { Connection: 'close' }); res.end()
        return
      }
      const code          = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error         = url.searchParams.get('error')

      const html = `<!doctype html><html><body style="font-family:system-ui;padding:2rem;">
        <h2>${error ? 'Authorization failed' : 'You can close this tab'}</h2>
        <p>${error ?? ''}</p></body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' })
      res.end(html)

      if (error)                   return reject(new Error(`oauth error: ${error}`))
      if (!code)                   return reject(new Error('callback missing code'))
      if (returnedState !== state) return reject(new Error('state mismatch — possible CSRF'))
      resolve(code)
    })
    setTimeout(
      () => reject(new Error(`timeout waiting for browser auth (${BROWSER_AUTH_TIMEOUT_MS / 1000}s)`)),
      BROWSER_AUTH_TIMEOUT_MS
    )
  }).finally(() => server.close())

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     CLIENT_ID,
      code,
      redirect_uri:  redirectUri,
      state,
      code_verifier,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text}`)
  const tok = JSON.parse(text) as TokenResponse

  const info = tokenInfoFromResponse(tok)
  writeCache(info)
  return info
}

/**
 * Rotate the access_token using the refresh_token. Mutates the cache.
 *
 * Sends back the granted scope from the cache so we never accidentally request
 * something the user didn't grant (which would return 400 invalid_scope).
 */
export async function refresh(): Promise<TokenInfo> {
  const cache = readCache()
  if (!cache?.refresh_token) throw new Error('no refresh_token cached — run login() first')

  const scope = cache.scope || REFRESH_SCOPES_FALLBACK.join(' ')

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
  const tok = JSON.parse(text) as TokenResponse

  const next = tokenInfoFromResponse(tok, cache)
  writeCache(next)
  return next
}

/**
 * Delete the cached token. Anthropic doesn't expose a public revoke endpoint
 * for this client_id, so we rely on the `expires_in` window — the token
 * naturally expires server-side within an hour.
 */
export async function logout(): Promise<void> {
  if (existsSync(CACHE_PATH)) unlinkSync(CACHE_PATH)
}

/**
 * Read the cached access_token. Refreshes proactively if we're within
 * `REFRESH_LEEWAY_MS` of expiry. Throws if no cache exists.
 *
 * This is the primary entry point for the Sci UI server: call before every
 * upstream request that needs a Bearer.
 */
export async function getAccessToken(): Promise<string> {
  const cache = readCache()
  if (!cache) throw new Error('no OAuth token cached — run `sci-ui-auth login` first')

  if (cache.expires_at_ms && cache.expires_at_ms - Date.now() < REFRESH_LEEWAY_MS) {
    const next = await refresh()
    return next.access_token
  }
  return cache.access_token
}

/**
 * Concurrency guard: if multiple callers hit `getAccessTokenSafe` while a
 * refresh is in flight, they all await the same promise instead of triggering
 * N parallel refreshes (which Anthropic might rate-limit, and which would
 * race on the cache file).
 */
let refreshInFlight: Promise<TokenInfo> | null = null
export async function getAccessTokenSafe(): Promise<string> {
  const cache = readCache()
  if (!cache) throw new Error('no OAuth token cached — run `sci-ui-auth login` first')

  if (cache.expires_at_ms && cache.expires_at_ms - Date.now() < REFRESH_LEEWAY_MS) {
    if (!refreshInFlight) {
      refreshInFlight = refresh().finally(() => { refreshInFlight = null })
    }
    const next = await refreshInFlight
    return next.access_token
  }
  return cache.access_token
}
