import type { StorageAdapter } from '@sci/core'

export async function memoryStatus(adapter: StorageAdapter) {
  try {
    const stats = await adapter.getStats()
    const lastWrite = await adapter.getLastEpisodicWrite()
    return {
      ok: true,
      backend: stats.backend,
      counts: {
        episodic: stats.episodic,
        semantic: stats.semantic,
        identity: stats.identity,
        embeddings: stats.embeddings,
      },
      last_write: lastWrite?.toISOString() ?? null,
    }
  } catch (err) {
    return {
      ok: false,
      backend: adapter.backend,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
