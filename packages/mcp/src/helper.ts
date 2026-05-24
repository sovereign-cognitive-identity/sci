/**
 * HTTP client for the Rust helper's admin API (default 127.0.0.1:3002).
 *
 * The helper owns the single source of truth: SQLite + sqlite-vec. Memory
 * reads and writes go through it so the MCP and the proxy share one vector
 * store and one embedder (no hnswlib/sqlite-vec divergence, no model drift).
 *
 * Override the base URL with SCI_HELPER_URL.
 */

const HELPER_BASE: string = process.env['SCI_HELPER_URL'] ?? 'http://127.0.0.1:3002'

export interface HelperRecallResult {
  id: string
  type: 'episodic' | 'semantic' | 'identity'
  content: string
  score: number
  metadata: Record<string, unknown>
  occurredAt?: string
}

export interface HelperStatus {
  version: string
  uptimeSeconds: number
  stats: {
    episodic: number
    semantic: number
    identity: number
    embeddings: number
    auditTurns: number
    backend: string
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HELPER_BASE}${path}`)
  if (!res.ok) throw new Error(`sci helper ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HELPER_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(`sci helper ${path} → ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return res.json() as Promise<T>
}

export function helperRecall(
  query: string,
  profile?: string,
  limit = 10,
): Promise<HelperRecallResult[]> {
  const params = new URLSearchParams({ query, limit: String(limit) })
  if (profile) params.set('profile', profile)
  return getJson<HelperRecallResult[]>(`/sci/recall?${params}`)
}

export function helperStatus(): Promise<HelperStatus> {
  return getJson<HelperStatus>('/sci/status')
}

export function helperStoreEpisodic(input: {
  content: string
  profile?: string
  source?: string
  metadata?: Record<string, unknown>
}): Promise<{ id: string; stored: boolean }> {
  return postJson('/sci/memories', { kind: 'episodic', ...input })
}

export function helperStoreIdentity(input: {
  content: string
  category?: string
  confidence?: number
  metadata?: Record<string, unknown>
}): Promise<{ id: string; stored: boolean }> {
  return postJson('/sci/memories', { kind: 'identity', ...input })
}

export interface HelperIdentityFact {
  id: string
  content: string
  category: string | null
  confidence: number
  createdAt: string
  metadata: Record<string, unknown>
}

export function helperIdentity(opts: {
  query?: string
  category?: string
  limit?: number
}): Promise<HelperIdentityFact[]> {
  const params = new URLSearchParams()
  if (opts.query)    params.set('query',    opts.query)
  if (opts.category) params.set('category', opts.category)
  if (opts.limit)    params.set('limit',    String(opts.limit))
  return getJson<HelperIdentityFact[]>(`/sci/identity?${params}`)
}
