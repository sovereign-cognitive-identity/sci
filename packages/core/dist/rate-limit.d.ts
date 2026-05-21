import type { AgentTier } from './auth.js';
export declare const TIER_LIMITS: Record<AgentTier, number>;
export declare function checkAndIncrement(agentId: string, tier: AgentTier): Promise<{
    allowed: boolean;
    limit: number;
    count: number;
    retryAfterSeconds: number;
}>;
export declare function pruneOldBuckets(olderThanMinutes?: number): Promise<number>;
export declare function getCurrentUsage(agentId: string): Promise<number>;
//# sourceMappingURL=rate-limit.d.ts.map