/**
 * Agent auth — Phase 6
 *
 * Three tiers:
 *   trusted   — full access to all tools, all profiles (your own agents)
 *   standard  — profile-scoped access, can read+write assigned profile only
 *   public    — read-only, identity facts filtered to category=preference only
 *
 * Tokens are 32-byte random hex strings.
 * Only the SHA-256 hash is stored — the plaintext is never persisted.
 * Token format: sci_<tier_prefix>_<32hex>
 *   sci_t_...  = trusted
 *   sci_s_...  = standard
 *   sci_p_...  = public
 */
import { createHash, randomBytes } from 'crypto'
import { reader, writer } from './db.js'

export type AgentTier = 'trusted' | 'standard' | 'public'

export interface AgentContext {
  agentId: string
  agentName: string
  tier: AgentTier
  profileId: string | null  // null = all profiles (trusted) or unscoped (public)
}

// ── Token generation ──────────────────────────────────────────────────────────

const TIER_PREFIX: Record<AgentTier, string> = {
  trusted: 't',
  standard: 's',
  public: 'p',
}

export function generateToken(tier: AgentTier): string {
  const random = randomBytes(32).toString('hex')
  return `sci_${TIER_PREFIX[tier]}_${random}`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ── Token validation ──────────────────────────────────────────────────────────

export async function validateToken(token: string): Promise<AgentContext | null> {
  if (!token?.startsWith('sci_')) return null

  const hash = hashToken(token)

  const { rows } = await reader.query<{
    agent_id: string
    agent_name: string
    tier: AgentTier
    profile_id: string | null
    expires_at: Date | null
  }>(
    `SELECT a.id AS agent_id, a.name AS agent_name, a.tier, a.profile_id,
            t.expires_at
     FROM agent_tokens t
     JOIN agents a ON a.id = t.agent_id
     WHERE t.token_hash = $1`,
    [hash]
  )

  const row = rows[0]
  if (!row) return null
  if (row.expires_at && row.expires_at < new Date()) return null

  // Update last_used_at (fire and forget)
  writer.query(
    `UPDATE agent_tokens SET last_used_at = NOW() WHERE token_hash = $1`,
    [hash]
  ).catch(() => {})

  return {
    agentId: row.agent_id,
    agentName: row.agent_name,
    tier: row.tier,
    profileId: row.profile_id,
  }
}

// ── Agent registration ────────────────────────────────────────────────────────

export interface RegisteredAgent {
  agentId: string
  token: string       // plaintext — show once, never stored
  tokenHint: string
  tier: AgentTier
  profileId: string | null
  profileName: string | null
}

export async function registerAgent(
  name: string,
  tier: AgentTier,
  profileName?: string
): Promise<RegisteredAgent> {
  // Resolve profile if given
  let profileId: string | null = null
  let resolvedProfileName: string | null = null
  if (profileName) {
    const { rows } = await reader.query<{ id: string; name: string }>(
      'SELECT id, name FROM profiles WHERE name = $1',
      [profileName]
    )
    if (!rows[0]) throw new Error(`Profile not found: ${profileName}`)
    profileId = rows[0].id
    resolvedProfileName = rows[0].name
  }

  // Upsert agent
  const { rows: agentRows } = await writer.query<{ id: string }>(
    `INSERT INTO agents (name, tier, profile_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET tier = EXCLUDED.tier, profile_id = EXCLUDED.profile_id
     RETURNING id`,
    [name, tier, profileId]
  )
  const agentId = agentRows[0]!.id

  // Generate token
  const token = generateToken(tier)
  const tokenHash = hashToken(token)
  const tokenHint = token.slice(-4)

  // Revoke any existing tokens for this agent
  await writer.query(
    'DELETE FROM agent_tokens WHERE agent_id = $1',
    [agentId]
  )

  await writer.query(
    'INSERT INTO agent_tokens (agent_id, token_hash, token_hint) VALUES ($1, $2, $3)',
    [agentId, tokenHash, tokenHint]
  )

  return { agentId, token, tokenHint, tier, profileId, profileName: resolvedProfileName }
}

// ── Connect flow (short-lived codes) ─────────────────────────────────────────

export interface ConnectCode {
  code: string
  agentName: string
  tier: AgentTier
  profileName: string | null
  expiresAt: Date
}

export async function createConnectCode(
  agentName: string,
  tier: AgentTier,
  profileName?: string
): Promise<ConnectCode> {
  let profileId: string | null = null
  let resolvedProfileName: string | null = null
  if (profileName) {
    const { rows } = await reader.query<{ id: string; name: string }>(
      'SELECT id, name FROM profiles WHERE name = $1',
      [profileName]
    )
    if (!rows[0]) throw new Error(`Profile not found: ${profileName}`)
    profileId = rows[0].id
    resolvedProfileName = rows[0].name
  }

  // 8-char alphanumeric code
  const code = randomBytes(4).toString('hex').toUpperCase()

  const { rows } = await writer.query<{ expires_at: Date }>(
    `INSERT INTO connect_requests (code, agent_name, tier, profile_id)
     VALUES ($1, $2, $3, $4)
     RETURNING expires_at`,
    [code, agentName, tier, profileId]
  )

  return {
    code,
    agentName,
    tier,
    profileName: resolvedProfileName,
    expiresAt: rows[0]!.expires_at,
  }
}

export async function redeemConnectCode(code: string): Promise<RegisteredAgent> {
  const { rows } = await reader.query<{
    agent_name: string
    tier: AgentTier
    profile_id: string | null
    expires_at: Date
    used_at: Date | null
  }>(
    'SELECT agent_name, tier, profile_id, expires_at, used_at FROM connect_requests WHERE code = $1',
    [code]
  )

  const req = rows[0]
  if (!req) throw new Error('Invalid code')
  if (req.used_at) throw new Error('Code already used')
  if (req.expires_at < new Date()) throw new Error('Code expired')

  // Mark as used
  await writer.query(
    'UPDATE connect_requests SET used_at = NOW() WHERE code = $1',
    [code]
  )

  // Get profile name if scoped
  let profileName: string | null = null
  if (req.profile_id) {
    const { rows: pRows } = await reader.query<{ name: string }>(
      'SELECT name FROM profiles WHERE id = $1',
      [req.profile_id]
    )
    profileName = pRows[0]?.name ?? null
  }

  return registerAgent(req.agent_name, req.tier, profileName ?? undefined)
}

// ── Tier access rules ─────────────────────────────────────────────────────────

export const TIER_RULES: Record<AgentTier, {
  canWrite: boolean
  canReadIdentity: boolean
  identityCategoryFilter: string[] | null  // null = all
  profileScoped: boolean
  canAnonymize: boolean
  canRoute: boolean
}> = {
  trusted: {
    canWrite: true,
    canReadIdentity: true,
    identityCategoryFilter: null,
    profileScoped: false,
    canAnonymize: true,
    canRoute: true,
  },
  standard: {
    canWrite: true,
    canReadIdentity: false,
    identityCategoryFilter: null,
    profileScoped: true,    // can only access assigned profile
    canAnonymize: true,
    canRoute: true,
  },
  public: {
    canWrite: false,
    canReadIdentity: true,
    identityCategoryFilter: ['preference'],  // only preferences, not relationships etc.
    profileScoped: false,
    canAnonymize: false,
    canRoute: false,
  },
}

export function canAccess(
  context: AgentContext,
  action: 'write' | 'readIdentity' | 'anonymize' | 'route'
): boolean {
  const rules = TIER_RULES[context.tier]
  switch (action) {
    case 'write': return rules.canWrite
    case 'readIdentity': return rules.canReadIdentity
    case 'anonymize': return rules.canAnonymize
    case 'route': return rules.canRoute
  }
}
