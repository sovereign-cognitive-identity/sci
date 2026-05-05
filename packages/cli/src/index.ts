#!/usr/bin/env node
import { Command } from 'commander'
import pg from 'pg'
import { runImport } from './import.js'
import { drainPools, registerAgent, reader, writer } from '@sci/core'
import { runBackup, runRestore } from './backup.js'
import type { AgentTier } from '@sci/core'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Resolve real MCP server path from CLI location: packages/cli/dist → packages/mcp/dist
const MCP_SERVER_PATH = resolve(__dirname, '../../mcp/dist/index.js')

const { Pool } = pg

const program = new Command()
program.name('sci').description('Sovereign Cognitive Identity').version('0.1.0')

// ── sci status ────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Check Postgres connection and memory counts')
  .action(async () => {
    const pool = new Pool({ connectionString: requireEnv('SCI_DB_READER_URL') })
    try {
      const [episodic, semantic, identity, embeddings, queue] = await Promise.all([
        pool.query<{ count: string }>('SELECT COUNT(*) FROM episodic_memories'),
        pool.query<{ count: string }>('SELECT COUNT(*) FROM semantic_nodes'),
        pool.query<{ count: string }>('SELECT COUNT(*) FROM identity_facts'),
        pool.query<{ count: string }>('SELECT COUNT(*) FROM embeddings'),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM write_queue WHERE status = 'pending'`),
      ])
      console.log('ok: true')
      console.log(`episodic:        ${episodic.rows[0]!.count}`)
      console.log(`semantic:        ${semantic.rows[0]!.count}`)
      console.log(`identity:        ${identity.rows[0]!.count}`)
      console.log(`embeddings:      ${embeddings.rows[0]!.count}`)
      console.log(`queue (pending): ${queue.rows[0]!.count}`)
    } catch (err) {
      console.error('ok: false')
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    } finally {
      await pool.end()
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

program.parse()

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
