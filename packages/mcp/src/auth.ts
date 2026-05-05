/**
 * MCP auth middleware.
 *
 * Reads SCI_AGENT_TOKEN from the environment (set in the MCP server config).
 * Validates the token on startup and makes the AgentContext available to tools.
 *
 * Tier enforcement:
 *   trusted  — all tools, all profiles
 *   standard — memory_recall + memory_store (profile-scoped), message_anonymize, route_query
 *              NO memory_identity (identity facts are global, not profile-scoped)
 *   public   — memory_recall (read-only, profile ignored), memory_identity (preferences only)
 *              NO memory_store, message_anonymize, session_inspect, route_query
 *
 * Missing token → defaults to trusted for local dev (SCI_REQUIRE_AUTH=true to enforce)
 */
import { validateToken, TIER_RULES } from '@sci/core'
import type { AgentContext, AgentTier } from '@sci/core'

export type { AgentContext, AgentTier }

const LOCAL_DEV_CONTEXT: AgentContext = {
  agentId: 'local-dev',
  agentName: 'local-dev',
  tier: 'trusted',
  profileId: null,
}

export async function loadAgentContext(): Promise<AgentContext> {
  const token = process.env['SCI_AGENT_TOKEN']
  const requireAuth = process.env['SCI_REQUIRE_AUTH'] === 'true'

  if (!token) {
    if (requireAuth) throw new Error('SCI_AGENT_TOKEN is required but not set')
    return LOCAL_DEV_CONTEXT
  }

  const context = await validateToken(token)
  if (!context) throw new Error('Invalid or expired SCI_AGENT_TOKEN')

  return context
}

export class AuthError extends Error {
  constructor(message: string, public tier: AgentTier, public action: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export function assertCan(
  context: AgentContext,
  action: 'write' | 'readIdentity' | 'anonymize' | 'route'
): void {
  const rules = TIER_RULES[context.tier]
  const allowed = {
    write: rules.canWrite,
    readIdentity: rules.canReadIdentity,
    anonymize: rules.canAnonymize,
    route: rules.canRoute,
  }[action]

  if (!allowed) {
    throw new AuthError(
      `Tier '${context.tier}' cannot perform action '${action}'`,
      context.tier,
      action
    )
  }
}

/** Return the profile ID to use for this request.
 *  Standard tier: always uses the token's assigned profile.
 *  Trusted tier: uses the requested profile, or 'work' as default.
 */
export async function resolveProfileId(
  requestedProfile: string | undefined,
  context: AgentContext,
  adapter: import('@sci/core').StorageAdapter
): Promise<string> {
  if (context.tier === 'standard' && context.profileId) {
    return context.profileId
  }

  const name = requestedProfile ?? 'work'
  const profile = await adapter.getProfile(name)
  if (!profile) throw new Error(`Profile not found: ${name}`)
  return profile.id
}
