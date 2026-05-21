import { audit, validateToken, checkRateLimit, touchDeviceLastSeen, reader, } from '@sci/core';
import { lookupIdentityByPeerIp } from '../identity.js';
const REQUIRE_AUTH = process.env['SCI_REQUIRE_AUTH'] === 'true';
const LOCAL_DEV_CONTEXT = {
    agentId: '00000000-0000-0000-0000-000000000000',
    agentName: 'local-dev',
    tier: 'trusted',
    profileId: null,
};
async function findDeviceIdForAgent(agentId) {
    if (agentId === LOCAL_DEV_CONTEXT.agentId)
        return null;
    const { rows } = await reader.query(`SELECT id FROM devices WHERE agent_id = $1 AND status = 'active' LIMIT 1`, [agentId]);
    return rows[0]?.id ?? null;
}
export const proxyAuth = async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    let agent = null;
    let identityDeviceId = null;
    let identityUserId = null;
    if (token)
        agent = await validateToken(token);
    // If no Sci-issued bearer token resolved an agent, fall back to source-IP
    // identity. In Hub / tunneled deployments the device's WG-assigned IP
    // (or LAN IP) maps directly to a registered device → agent → user. This
    // makes audit rows + memory + rate limiting work for clients (Claude Code,
    // Cursor, etc.) that authenticate to upstream providers but not to Sci.
    if (!agent) {
        const peerIp = c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            ?? c.env
                ?.incoming?.socket?.remoteAddress
            ?? null;
        if (peerIp) {
            const id = await lookupIdentityByPeerIp(peerIp).catch(() => null);
            if (id) {
                agent = id.context;
                identityDeviceId = id.deviceId;
                identityUserId = id.userId;
            }
        }
    }
    if (!agent) {
        if (REQUIRE_AUTH) {
            await audit({ action: 'proxy.denied', target: c.req.path, outcome: 'denied',
                metadata: { reason: 'missing or invalid token' } });
            return c.json({
                error: { type: 'authentication_error', message: 'Sci: missing or invalid Authorization bearer token' }
            }, 401);
        }
        agent = LOCAL_DEV_CONTEXT;
    }
    // Rate limit (skip for local-dev so tests can spam)
    if (agent.agentId !== LOCAL_DEV_CONTEXT.agentId) {
        const rl = await checkRateLimit(agent.agentId, agent.tier);
        if (!rl.allowed) {
            await audit({ agentId: agent.agentId, action: 'rate_limit.exceeded',
                outcome: 'denied', target: c.req.path,
                metadata: { limit: rl.limit, count: rl.count } });
            c.header('Retry-After', String(rl.retryAfterSeconds));
            c.header('X-Sci-RateLimit-Limit', String(rl.limit));
            c.header('X-Sci-RateLimit-Remaining', '0');
            return c.json({
                error: { type: 'rate_limit_error',
                    message: `Sci: rate limit exceeded (${rl.count}/${rl.limit} per minute)` }
            }, 429);
        }
    }
    // Prefer device/user from source-IP lookup (already resolved above) before
    // falling back to agent-id-only lookup for token-authenticated callers.
    const deviceId = identityDeviceId
        ?? await findDeviceIdForAgent(agent.agentId).catch(() => null);
    if (deviceId)
        touchDeviceLastSeen(agent.agentId).catch(() => { });
    c.set('agent', agent);
    c.set('deviceId', deviceId);
    c.set('userId', identityUserId);
    const limitForHeader = agent.agentId === LOCAL_DEV_CONTEXT.agentId ? null : agent.tier;
    // For audit attribution: LOCAL_DEV_CONTEXT's all-zeros UUID isn't a real
    // row in `agents`, so passing it would FK-violate. The column is nullable,
    // so write null when we're in dev/no-auth fallback. The dashboard
    // surfaces these rows under "anonymous" and they're still attributable
    // by source IP / metadata.
    const auditAgentId = agent.agentId === LOCAL_DEV_CONTEXT.agentId ? null : agent.agentId;
    // Audit on completion (after handler runs — capture status)
    const start = Date.now();
    try {
        await next();
        // Set rate-limit headers on the final response (handlers replace c.res
        // with a fresh streaming Response, so we have to mutate after next()).
        if (limitForHeader && c.res.headers) {
            const TIER_LIMIT = { trusted: 1000, standard: 120, public: 30 }[limitForHeader];
            c.res.headers.set('X-Sci-RateLimit-Limit', String(TIER_LIMIT));
        }
        const status = c.res.status;
        audit({
            userId: identityUserId,
            agentId: auditAgentId, deviceId,
            action: 'proxy.request',
            target: c.req.path,
            outcome: status >= 400 ? 'error' : 'ok',
            metadata: { method: c.req.method, status, ms: Date.now() - start },
        }).catch(() => { });
    }
    catch (e) {
        audit({
            userId: identityUserId,
            agentId: auditAgentId, deviceId,
            action: 'proxy.request', outcome: 'error', target: c.req.path,
            metadata: { error: e.message, ms: Date.now() - start },
        }).catch(() => { });
        throw e;
    }
};
//# sourceMappingURL=auth.js.map