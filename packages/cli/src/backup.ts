/**
 * Backup and restore for the local Postgres backend.
 *
 * sci backup [--out <path>]   — exports all data to a JSON file
 * sci restore <file>          — imports data from a JSON backup
 *
 * The backup format is a plain JSON object containing all tables.
 * It is human-readable and portable — you own it.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { createStorageAdapter } from '@sci/core'
import { reader, writer } from '@sci/core'

export interface BackupData {
  version: string
  created_at: string
  profiles: unknown[]
  episodic_memories: unknown[]
  semantic_nodes: unknown[]
  semantic_edges: unknown[]
  identity_facts: unknown[]
  embeddings: unknown[]
  consolidation_runs: unknown[]
  agents: unknown[]
}

export async function runBackup(outPath: string): Promise<void> {
  console.log('Exporting data...')

  const tables = [
    'profiles',
    'episodic_memories',
    'semantic_nodes',
    'semantic_edges',
    'identity_facts',
    'embeddings',
    'consolidation_runs',
    'agents',
  ]

  const backup: Record<string, unknown> = {
    version: '1',
    created_at: new Date().toISOString(),
  }

  for (const table of tables) {
    const { rows } = await reader.query(`SELECT * FROM ${table} ORDER BY created_at ASC`)
    backup[table] = rows
    console.log(`  ${table}: ${rows.length} rows`)
  }

  writeFileSync(outPath, JSON.stringify(backup, null, 2), 'utf-8')
  const size = (Buffer.byteLength(JSON.stringify(backup)) / 1024).toFixed(1)
  console.log(`\n✓ Backup written to ${outPath} (${size} KB)`)
}

export async function runRestore(filePath: string, { force }: { force: boolean }): Promise<void> {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const backup = JSON.parse(readFileSync(filePath, 'utf-8')) as BackupData

  if (!backup.version || !backup.created_at) {
    console.error('Invalid backup file — missing version or created_at')
    process.exit(1)
  }

  console.log(`Restoring from backup created ${backup.created_at}`)

  if (!force) {
    const { rows } = await reader.query('SELECT COUNT(*) FROM episodic_memories')
    const count = parseInt((rows[0] as { count: string }).count)
    if (count > 0) {
      console.error(`\nDatabase is not empty (${count} episodic memories exist).`)
      console.error('Use --force to overwrite. This cannot be undone.')
      process.exit(1)
    }
  }

  const client = await writer.connect()
  try {
    await client.query('BEGIN')

    if (force) {
      // Clear in reverse dependency order
      for (const table of [
        'embeddings', 'semantic_edges', 'semantic_nodes',
        'episodic_memories', 'identity_facts',
        'agents', 'consolidation_runs', 'profiles',
      ]) {
        await client.query(`DELETE FROM ${table}`)
      }
      console.log('  Cleared existing data')
    }

    const restore = async (table: string, rows: Record<string, unknown>[]) => {
      if (!rows?.length) return
      for (const row of rows) {
        const cols = Object.keys(row)
        const vals = cols.map((_, i) => `$${i + 1}`)
        await client.query(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT DO NOTHING`,
          cols.map(c => row[c])
        )
      }
      console.log(`  ${table}: ${rows.length} rows restored`)
    }

    // Restore in dependency order
    await restore('profiles', backup.profiles as Record<string, unknown>[])
    await restore('episodic_memories', backup.episodic_memories as Record<string, unknown>[])
    await restore('semantic_nodes', backup.semantic_nodes as Record<string, unknown>[])
    await restore('semantic_edges', backup.semantic_edges as Record<string, unknown>[])
    await restore('identity_facts', backup.identity_facts as Record<string, unknown>[])
    await restore('embeddings', backup.embeddings as Record<string, unknown>[])
    await restore('consolidation_runs', backup.consolidation_runs as Record<string, unknown>[])
    await restore('agents', backup.agents as Record<string, unknown>[])

    await client.query('COMMIT')
    console.log('\n✓ Restore complete')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
