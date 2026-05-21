import { reader } from '@sci/core';
const identityCache = new Map();
const IDENTITY_TTL_MS = 60_000;
/**
 * Resolve a peer IP to an identity. Returns null when no active device is
 * registered with that IP. Result (including null misses) is cached for
 * 60s — short enough to pick up device additions / revocations without
 * being a hot DB hit per request.
 */
export async function lookupIdentityByPeerIp(peerIp) {
    const now = Date.now();
    const cached = identityCache.get(peerIp);
    if (cached && cached.expiresAt > now)
        return cached.row;
    const { rows } = await reader.query(`SELECT a.id AS agent_id, a.name AS agent_name, a.tier, a.profile_id,
            d.id AS device_id, d.user_id
     FROM devices d JOIN agents a ON a.id = d.agent_id
     WHERE d.wg_assigned_ip = $1 AND d.status = 'active' LIMIT 1`, [peerIp]);
    const r = rows[0];
    const row = r
        ? {
            context: {
                agentId: r.agent_id,
                agentName: r.agent_name,
                tier: r.tier,
                profileId: r.profile_id,
            },
            deviceId: r.device_id,
            userId: r.user_id,
        }
        : null;
    identityCache.set(peerIp, { row, expiresAt: now + IDENTITY_TTL_MS });
    return row;
}
//# sourceMappingURL=identity.js.map