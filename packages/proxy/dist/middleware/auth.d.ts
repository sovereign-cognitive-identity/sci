/**
 * Proxy auth + audit + rate-limit middleware.
 *
 * Sits in front of /v1/messages and /v1/chat/completions. Order:
 *   1. Pull the bearer token from the Authorization header. If
 *      SCI_REQUIRE_AUTH is true, missing/invalid → 401.
 *   2. Validate the token against agent_tokens. On hit, attach the
 *      AgentContext to c.var so handlers can read it.
 *   3. Check rate limit by tier. Over limit → 429 with Retry-After.
 *   4. Touch the device's last_seen_at (fire and forget) so the dashboard
 *      shows live activity.
 *   5. Audit an entry for the request (ok / denied / error).
 *
 * Notes:
 *  - Local dev convenience: SCI_REQUIRE_AUTH=false (default) gives every
 *    caller a fake "trusted" context — this is the historical behavior.
 *  - The handler reads c.get('agent') to scope memory recall + writes
 *    to the agent's profile. (Currently the handlers ignore this and
 *    use the default profile; wiring through is the data plane's next
 *    refactor — kept narrow tonight.)
 */
import type { MiddlewareHandler } from 'hono';
import { type AgentContext } from '@sci/core';
export interface ProxyAuthVars {
    agent: AgentContext;
    deviceId: string | null;
    userId: string | null;
}
export declare const proxyAuth: MiddlewareHandler<{
    Variables: ProxyAuthVars;
}>;
//# sourceMappingURL=auth.d.ts.map