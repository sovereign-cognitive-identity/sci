import { helperStatus } from '../helper.js'

export async function memoryStatus() {
  try {
    const s = await helperStatus()
    return {
      ok: true,
      backend: s.stats.backend,
      counts: {
        episodic: s.stats.episodic,
        semantic: s.stats.semantic,
        identity: s.stats.identity,
        embeddings: s.stats.embeddings,
      },
      uptime_seconds: s.uptimeSeconds,
    }
  } catch (err) {
    return {
      ok: false,
      backend: 'sqlite',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
