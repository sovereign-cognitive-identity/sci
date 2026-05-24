#!/usr/bin/env node
import { Command } from 'commander'
import { runImport } from './import.js'
import { drainPools, registerAgent, reader, writer, createStorageAdapter } from '@sci/core'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { runBackup, runRestore } from './backup.js'
import { runStatus, runVerify } from './status.js'
import type { AgentTier } from '@sci/core'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Resolve real MCP server path from CLI location: packages/cli/dist → packages/mcp/dist
const MCP_SERVER_PATH = resolve(__dirname, '../../mcp/dist/index.js')

const program = new Command()
program.name('sci').description('Sovereign Cognitive Identity').version('0.1.0')

// ── sci status ────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('System-wide health check (proxy, agent, MCP, CA, credentials)')
  .action(async () => {
    await runStatus()
  })

// ── sci verify ────────────────────────────────────────────────────────────────

program
  .command('verify')
  .description('Live smoke test — send a request through the proxy and confirm it works')
  .action(async () => {
    await runVerify()
  })

// ── sci db-status ─────────────────────────────────────────────────────────────

program
  .command('db-status')
  .description('Check storage backend and memory counts')
  .action(async () => {
    // Backend-agnostic: honors SCI_STORAGE_BACKEND (sqlite | local/postgres | …).
    // Defaults to sqlite (~/.sci/memory) so `sci db-status` works with no Docker.
    process.env['SCI_STORAGE_BACKEND'] ??= 'sqlite'
    try {
      const adapter = await createStorageAdapter()
      const stats = await adapter.getStats()
      console.log('ok: true')
      console.log(`backend:    ${stats.backend}`)
      console.log(`episodic:   ${stats.episodic}`)
      console.log(`semantic:   ${stats.semantic}`)
      console.log(`identity:   ${stats.identity}`)
      console.log(`embeddings: ${stats.embeddings}`)
      await adapter.disconnect()
    } catch (err) {
      console.error('ok: false')
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ── sci import ────────────────────────────────────────────────────────────────

program
  .command('import')
  .description('Import conversation history to seed memory')
  .requiredOption('--claude <file>', 'Path to Claude conversations.json export')
  .option('--profile <name>', 'Target profile', 'work')
  .option('--limit <n>', 'Max conversations to import', '100')
  .option('--verbose', 'Log every stored memory', false)
  .action(async (opts: { claude: string; profile: string; limit: string; verbose: boolean }) => {
    try {
      await runImport({
        file: opts.claude,
        profile: opts.profile,
        limit: parseInt(opts.limit),
        verbose: opts.verbose,
      })
      await drainPools()
      process.exit(0)
    } catch (err) {
      console.error('Import failed:', err instanceof Error ? err.message : String(err))
      await drainPools()
      process.exit(1)
    }
  })

// ── sci connect ───────────────────────────────────────────────────────────────

program
  .command('connect')
  .description('Connect a new agent and generate an access token')
  .argument('<name>', 'Agent name (e.g. cursor, copilot, my-agent)')
  .option('--tier <tier>', 'Access tier: trusted | standard | public', 'standard')
  .option('--profile <name>', 'Profile to scope access to (standard tier only)')
  .action(async (name: string, opts: { tier: string; profile?: string }) => {
    const tier = opts.tier as AgentTier
    if (!['trusted', 'standard', 'public'].includes(tier)) {
      console.error('Invalid tier. Use: trusted | standard | public')
      await drainPools(); process.exit(1)
    }

    try {
      const result = await registerAgent(name, tier, opts.profile)

      console.log(`\n✓ Agent connected: ${name}`)
      console.log(`  Tier:    ${result.tier}`)
      if (result.profileName) console.log(`  Profile: ${result.profileName}`)
      console.log(`\n  Token (show once — store securely):`)
      console.log(`  ${result.token}`)
      console.log(`\n  Add to your MCP config:`)
      console.log(`  {`)
      console.log(`    "command": "node",`)
      console.log(`    "args": ["${MCP_SERVER_PATH}"],`)
      console.log(`    "env": {`)
      console.log(`      "SCI_AGENT_TOKEN": "${result.token}",`)
      console.log(`      "SCI_DB_READER_URL": "${process.env['SCI_DB_READER_URL'] ?? 'postgresql://sci_reader:sci_reader_local@localhost:5432/sci'}",`)
      console.log(`      "SCI_DB_WRITER_URL": "${process.env['SCI_DB_WRITER_URL'] ?? 'postgresql://sci_writer:sci_writer_local@localhost:5432/sci'}"`)
      console.log(`    }`)
      console.log(`  }`)
    } catch (err) {
      console.error('Failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }

    await drainPools()
    process.exit(0)
  })

// ── sci agents ────────────────────────────────────────────────────────────────

program
  .command('agents')
  .description('List connected agents')
  .action(async () => {
    try {
      const { rows } = await reader.query<{
        name: string
        tier: string
        profile_name: string | null
        last_used_at: Date | null
        token_hint: string
      }>(
        `SELECT a.name, a.tier,
                p.name AS profile_name,
                t.last_used_at, t.token_hint
         FROM agents a
         LEFT JOIN profiles p ON p.id = a.profile_id
         LEFT JOIN agent_tokens t ON t.agent_id = a.id
         ORDER BY a.name`
      )

      if (rows.length === 0) {
        console.log('No agents connected. Run: sci connect <name>')
      } else {
        console.log('\nConnected agents:\n')
        rows.forEach(r => {
          const lastUsed = r.last_used_at
            ? new Date(r.last_used_at).toLocaleDateString()
            : 'never'
          const profile = r.profile_name ? ` → ${r.profile_name}` : ''
          console.log(`  ${r.name.padEnd(20)} [${r.tier}${profile}]  last used: ${lastUsed}  token: ...${r.token_hint}`)
        })
        console.log()
      }
    } catch (err) {
      console.error('Failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }

    await drainPools()
    process.exit(0)
  })

// ── sci vpn ───────────────────────────────────────────────────────────────────

const vpn = program.command('vpn').description('Manage the Sci VPN (transparent AI traffic proxy)')

vpn
  .command('install')
  .description('Install Sci VPN — intercepts ALL AI API traffic system-wide (requires admin)')
  .action(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vpnSetup: any = await import(resolve(__dirname, '../../proxy/dist/vpn-setup.js'))
      const { installVPN } = vpnSetup as { installVPN: () => Promise<void> }
      await installVPN()
    } catch (err) {
      console.error('Install failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }
    await drainPools(); process.exit(0)
  })

vpn
  .command('uninstall')
  .description('Uninstall Sci VPN — restore normal AI API routing')
  .action(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { uninstallVPN } = (await import(resolve(__dirname, '../../proxy/dist/vpn-setup.js'))) as any
      await uninstallVPN()
    } catch (err) {
      console.error('Uninstall failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }
    await drainPools(); process.exit(0)
  })

vpn
  .command('status')
  .description('Show VPN status')
  .action(async () => {
    try {
      const { readFileSync } = await import('fs')
      const hosts = readFileSync('/etc/hosts', 'utf-8')
      const active = hosts.includes('# BEGIN sci-vpn')
      const proxyUp = await fetch('http://localhost:3001/health').then(() => true).catch(() => false)
      console.log(`\nSci VPN Status`)
      console.log(`  /etc/hosts redirect: ${active ? '✓ active' : '✗ not installed'}`)
      console.log(`  Proxy running:       ${proxyUp ? '✓ yes (port 3001)' : '✗ no'}`)
      console.log(`  Proxy log:           ~/Vault/sci/proxy.log\n`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
    }
    await drainPools(); process.exit(0)
  })

// ── sci proxy ─────────────────────────────────────────────────────────────────

program
  .command('proxy')
  .description('Start the Sci proxy server (anonymizes all AI API calls)')
  .option('--port <n>', 'Port to listen on', '3001')
  .option('--routing <mode>', 'Routing mode: passthrough | smart', 'passthrough')
  .action(async (opts: { port: string; routing: string }) => {
    const { spawn } = await import('child_process')
    const serverPath = resolve(__dirname, '../../proxy/dist/index.js')

    if (!existsSync(serverPath)) {
      console.error('Proxy server not built. Run: npm run build -w packages/proxy')
      await drainPools(); process.exit(1)
    }

    const openrouterKey = process.env['SCI_OPENROUTER_KEY']
    if (!openrouterKey) {
      console.error('SCI_OPENROUTER_KEY is required for the proxy')
      await drainPools(); process.exit(1)
    }

    console.log(`Starting Sci proxy on port ${opts.port}...`)
    const child = spawn('node', [serverPath], {
      env: {
        ...process.env,
        SCI_PROXY_PORT: opts.port,
        SCI_ROUTING_MODE: opts.routing,
      },
      stdio: 'inherit',
    })
    child.on('exit', (code) => process.exit(code ?? 0))

    await drainPools()
  })

// ── sci backup ────────────────────────────────────────────────────────────────

program
  .command('backup')
  .description('Export all data to a JSON file')
  .option('--out <path>', 'Output file path', `./sci-backup-${new Date().toISOString().slice(0,10)}.json`)
  .action(async (opts: { out: string }) => {
    try {
      await runBackup(opts.out)
    } catch (err) {
      console.error('Backup failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }
    await drainPools(); process.exit(0)
  })

// ── sci restore ───────────────────────────────────────────────────────────────

program
  .command('restore')
  .description('Restore data from a JSON backup file')
  .argument('<file>', 'Path to backup JSON file')
  .option('--force', 'Overwrite existing data', false)
  .action(async (file: string, opts: { force: boolean }) => {
    try {
      await runRestore(file, opts)
    } catch (err) {
      console.error('Restore failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }
    await drainPools(); process.exit(0)
  })

// ── sci revoke ────────────────────────────────────────────────────────────────

program
  .command('revoke')
  .description('Revoke an agent\'s access token')
  .argument('<name>', 'Agent name to revoke')
  .action(async (name: string) => {
    try {
      const { rows } = await reader.query<{ id: string }>(
        'SELECT id FROM agents WHERE name = $1', [name]
      )
      if (!rows[0]) {
        console.error(`Agent not found: ${name}`)
        await drainPools(); process.exit(1)
      }
      await writer.query('DELETE FROM agent_tokens WHERE agent_id = $1', [rows[0].id])
      console.log(`✓ Token revoked for agent: ${name}`)
      console.log(`  Run 'sci connect ${name}' to issue a new token.`)
    } catch (err) {
      console.error('Failed:', err instanceof Error ? err.message : String(err))
      await drainPools(); process.exit(1)
    }
    await drainPools()
    process.exit(0)
  })

// ── sci setup ─────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('First-run setup wizard — verify DB, generate token, output MCP config')
  .action(async () => {
    const dbReaderUrl = process.env['SCI_DB_READER_URL'] ?? 'postgresql://sci_reader:sci_reader_local@localhost:5432/sci'
    const dbWriterUrl = process.env['SCI_DB_WRITER_URL'] ?? 'postgresql://sci_writer:sci_writer_local@localhost:5432/sci'

    console.log('\n🔧 Sci Setup\n')

    // Step 1: DB check
    process.stdout.write('  [1/4] Checking database connection... ')
    try {
      await reader.query('SELECT 1')
      console.log('✓')
    } catch (err) {
      console.log('✗')
      console.error(`\n  Cannot connect to Postgres: ${err instanceof Error ? err.message : String(err)}`)
      console.error(`\n  Make sure Docker is running and try: docker compose up -d`)
      await drainPools(); process.exit(1)
    }

    // Step 2: Schema check
    process.stdout.write('  [2/4] Checking schema... ')
    try {
      const { rows } = await reader.query<{ count: string }>('SELECT COUNT(*) FROM profiles')
      const count = parseInt(rows[0]!.count)
      console.log(`✓  (${count} profiles)`)
    } catch {
      console.log('✗')
      console.error('\n  Schema not found. Run: docker compose up -d')
      await drainPools(); process.exit(1)
    }

    // Step 3: Memory counts
    process.stdout.write('  [3/4] Checking memory counts... ')
    try {
      const [e, s, i] = await Promise.all([
        reader.query<{ count: string }>('SELECT COUNT(*) FROM episodic_memories'),
        reader.query<{ count: string }>('SELECT COUNT(*) FROM semantic_nodes'),
        reader.query<{ count: string }>('SELECT COUNT(*) FROM identity_facts'),
      ])
      console.log(`✓  (episodic: ${e.rows[0]!.count}, semantic: ${s.rows[0]!.count}, identity: ${i.rows[0]!.count})`)
    } catch (err) {
      console.log(`⚠  ${err instanceof Error ? err.message : String(err)}`)
    }

    // Step 4: Token
    process.stdout.write('  [4/4] Setting up Claude Code token... ')
    try {
      const { rows: existing } = await reader.query(
        `SELECT t.token_hint FROM agent_tokens t JOIN agents a ON a.id = t.agent_id WHERE a.name = 'claude-code'`
      )
      if (existing.length > 0) {
        console.log(`✓  (already connected, token: ...${existing[0].token_hint})`)
        console.log(`\n✓ Sci is ready.`)
        console.log(`\n  To rotate the token: sci revoke claude-code && sci setup`)
        await drainPools(); process.exit(0)
      }

      const result = await registerAgent('claude-code', 'trusted')
      console.log('✓  (new token generated)')

      console.log(`\n${'─'.repeat(60)}`)
      console.log(`\n✓ Setup complete! Run this command to register Sci with Claude Code:\n`)
      console.log(`claude mcp add sci \\`)
      console.log(`  -e SCI_AGENT_TOKEN="${result.token}" \\`)
      console.log(`  -e SCI_DB_READER_URL="${dbReaderUrl}" \\`)
      console.log(`  -e SCI_DB_WRITER_URL="${dbWriterUrl}" \\`)
      console.log(`  -e SCI_EMBED_MODEL="BAAI/bge-base-en-v1.5" \\`)
      console.log(`  -- node "${MCP_SERVER_PATH}"`)
      console.log(`\n${'─'.repeat(60)}`)
      console.log(`\nToken (shown once — store securely if needed): ${result.token}\n`)
      console.log(`Next steps:`)
      console.log(`  1. Run the command above in your terminal`)
      console.log(`  2. Restart Claude Code`)
      console.log(`  3. Run: sci import --claude ~/Downloads/conversations.json`)
      console.log(`  4. Run: node demo/privacy-demo.mjs  (verify anonymization)\n`)
    } catch (err) {
      console.log('✗')
      console.error(`  ${err instanceof Error ? err.message : String(err)}`)
      await drainPools(); process.exit(1)
    }

    await drainPools()
    process.exit(0)
  })

// ── sci ui ────────────────────────────────────────────────────────────────────
//
// Spawns the @sci/ui server as a child process so the CLI doesn't take on
// a hard dep on @sci/ui (which would force a build-order rearrangement).
// Streams the server's stdio through to ours and forwards SIGINT cleanly.

program
  .command('ui')
  .description('Start the Sci chat UI server (subscription-billed via OAuth)')
  .option('--port <n>', 'Port to listen on', '3002')
  .option('--proxy-url <url>', 'Sci proxy URL', 'http://localhost:3001')
  .option('--model <id>', 'Default model', 'claude-haiku-4-5-20251001')
  .action(async (opts: { port: string; proxyUrl: string; model: string }) => {
    const { spawn } = await import('child_process')
    const uiServerPath = resolve(__dirname, '../../ui/dist/server.js')
    if (!existsSync(uiServerPath)) {
      console.error(`UI server build not found at: ${uiServerPath}`)
      console.error(`Run \`npm run build -w packages/ui\` from the repo root first.`)
      process.exit(1)
    }
    const child = spawn(process.execPath, [uiServerPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SCI_UI_PORT:           opts.port,
        SCI_PROXY_URL:         opts.proxyUrl,
        SCI_UI_DEFAULT_MODEL:  opts.model,
      },
    })
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig)
    process.on('SIGINT',  forward('SIGINT'))
    process.on('SIGTERM', forward('SIGTERM'))
    child.on('exit', (code) => process.exit(code ?? 0))
  })

program.parse()

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
