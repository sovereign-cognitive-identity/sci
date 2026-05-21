import pg from 'pg'

const { Pool } = pg

// Pools are created at module load but connection strings default to '' when
// env vars are absent — the Pool constructor does not connect eagerly, so
// processes that never touch the DB (e.g. `sci --version`, agent commands
// that use only SQLite) load this module without throwing. The first actual
// query will fail fast with a clear pg error if the vars are unset.
export const reader = new Pool({
  connectionString: process.env['SCI_DB_READER_URL'] ?? '',
  max: 5,
})

export const writer = new Pool({
  connectionString: process.env['SCI_DB_WRITER_URL'] ?? '',
  max: 3,
})

export async function checkConnection(): Promise<boolean> {
  try {
    await reader.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

/** Gracefully drain both pools. Call before process.exit to avoid exit 134. */
export async function drainPools(): Promise<void> {
  await Promise.allSettled([reader.end(), writer.end()])
}
