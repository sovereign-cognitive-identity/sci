/**
 * Source-IP-based identity resolution for tunneled / LAN-scope requests.
 *
 * Used by both the TLS interceptor (server-tls.ts, port 8443) and the Hono
 * auth middleware (middleware/auth.ts, port 3001) so that every authenticated
 * request — regardless of which entry path — has access to a consistent
 * `{ agentContext, deviceId, userId }` triple for downstream audit, memory,
 * and rate-limit decisions.
 *
 * The lookup matches `devices.wg_assigned_ip` to the peer IP. In Hub mode
 * (LAN scope, SCI-104) the same column is repurposed to hold the device's
 * LAN IP. In Cloud mode (tunnel scope) it's the WG-assigned IP. Same query,
 * same data.
 */
import type { AgentContext } from '@sci/core';
export interface IdentityRow {
    context: AgentContext;
    deviceId: string;
    userId: string | null;
}
/**
 * Resolve a peer IP to an identity. Returns null when no active device is
 * registered with that IP. Result (including null misses) is cached for
 * 60s — short enough to pick up device additions / revocations without
 * being a hot DB hit per request.
 */
export declare function lookupIdentityByPeerIp(peerIp: string): Promise<IdentityRow | null>;
//# sourceMappingURL=identity.d.ts.map