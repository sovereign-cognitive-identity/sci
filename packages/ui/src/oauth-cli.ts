#!/usr/bin/env node
/**
 * Manual smoke-test CLI for the OAuth module.
 *
 * Once Phase 1c lands, the UI server will call `oauth.ts` directly and
 * users will never invoke this. We keep it for ops / debugging — replacing
 * a token, inspecting cache state, or rotating manually.
 *
 *   node dist/oauth-cli.js login
 *   node dist/oauth-cli.js refresh
 *   node dist/oauth-cli.js logout
 *   node dist/oauth-cli.js status
 *   node dist/oauth-cli.js test       # pings api.anthropic.com /v1/messages
 */

import { login, refresh, logout, readCache, getAccessToken, ANTHROPIC_OAUTH_BETA } from './oauth.js'

const cmd = process.argv[2]

async function main() {
  switch (cmd) {
    case 'login': {
      console.log('starting OAuth flow…')
      const info = await login({
        onAuthUrl: (url) => {
          console.log('\nif your browser does not open, visit:\n')
          console.log(url)
          console.log()
        },
      })
      console.log('\n✓ login complete')
      console.log(`  scope:        ${info.scope}`)
      console.log(`  expires_at:   ${info.expires_at_ms ? new Date(info.expires_at_ms).toISOString() : 'never'}`)
      if (typeof info.organization === 'object' && info.organization && 'uuid' in info.organization) {
        console.log(`  organization: ${(info.organization as { uuid: string }).uuid}`)
      }
      return
    }
    case 'refresh': {
      const info = await refresh()
      console.log('✓ refresh complete')
      console.log(`  expires_at:   ${info.expires_at_ms ? new Date(info.expires_at_ms).toISOString() : 'never'}`)
      return
    }
    case 'logout': {
      await logout()
      console.log('✓ logged out (cache cleared)')
      return
    }
    case 'status': {
      const cache = readCache()
      if (!cache) { console.log('no cached token'); return }
      const ttl = cache.expires_at_ms ? cache.expires_at_ms - Date.now() : null
      console.log('cached token:')
      console.log(`  scope:        ${cache.scope}`)
      console.log(`  expires_at:   ${cache.expires_at_ms ? new Date(cache.expires_at_ms).toISOString() : 'never'}`)
      console.log(`  ttl:          ${ttl !== null ? `${Math.round(ttl / 1000)}s` : 'n/a'}`)
      console.log(`  access_token: ${cache.access_token.slice(0, 24)}…`)
      return
    }
    case 'test': {
      const token = await getAccessToken()
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization':     `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    ANTHROPIC_OAUTH_BETA,
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          messages:   [{ role: 'user', content: 'say POC and nothing else' }],
          max_tokens: 10,
        }),
      })
      const text = await res.text()
      console.log(`HTTP ${res.status}`)
      console.log(text.slice(0, 800))
      if (!res.ok) process.exit(1)
      return
    }
    default:
      console.log('usage: sci-ui-auth <login|refresh|logout|status|test>')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('error:', err.message)
  process.exit(1)
})
