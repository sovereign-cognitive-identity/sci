/**
 * Per-agent rate limiting. Buckets are 1-minute windows; the limit is the
 * number of requests allowed per minute. Tier defaults:
 *   trusted   — 1000/min  (effectively unlimited for personal use)
 *   standard  — 120/min   (2/sec)
 *   public    — 30/min    (0.5/sec)
 *
 * Implementation: UPSERT into rate_limits, atomic increment, return the
 * post-increment count. If it exceeds the limit, the request is denied.
 *
 * Old buckets are pruned by a periodic background job (or on-demand from
 * a cron). Pruning is not load-bearing — old rows simply waste space.
 */
import { writer, reader } from './db.js';
export const TIER_LIMITS = {
    trusted: 1000,
    standard: 120,
    public: 30,
};
export async function checkAndIncrement(agentId, tier) {
    const limit = TIER_LIMITS[tier];
    // Truncate to start-of-minute
    const { rows } = await writer.query(`INSERT INTO rate_limits (agent_id, window_start, request_count)
     VALUES ($1, date_trunc('minute', NOW()), 1)
     ON CONFLICT (agent_id, window_start)
     DO UPDATE SET request_count = rate_limits.request_count + 1
     RETURNING request_count`, [agentId]);
    const count = rows[0].request_count;
    const allowed = count <= limit;
    // Seconds until the next minute window starts
    const now = new Date();
    const retry = 60 - now.getSeconds();
    return { allowed, limit, count, retryAfterSeconds: retry };
}
export async function pruneOldBuckets(olderThanMinutes = 60) {
    const { rowCount } = await writer.query(`DELETE FROM rate_limits WHERE window_start < NOW() - $1::interval`, [`${olderThanMinutes} minutes`]);
    return rowCount ?? 0;
}
export async function getCurrentUsage(agentId) {
    const { rows } = await reader.query(`SELECT request_count FROM rate_limits
     WHERE agent_id = $1 AND window_start = date_trunc('minute', NOW())`, [agentId]);
    return rows[0]?.request_count ?? 0;
}
//# sourceMappingURL=rate-limit.js.map