export type AgentTier = 'trusted' | 'standard' | 'public';
export interface AgentContext {
    agentId: string;
    agentName: string;
    tier: AgentTier;
    profileId: string | null;
}
export declare function generateToken(tier: AgentTier): string;
export declare function hashToken(token: string): string;
export declare function validateToken(token: string): Promise<AgentContext | null>;
export interface RegisteredAgent {
    agentId: string;
    token: string;
    tokenHint: string;
    tier: AgentTier;
    profileId: string | null;
    profileName: string | null;
}
export declare function registerAgent(name: string, tier: AgentTier, profileName?: string): Promise<RegisteredAgent>;
export interface ConnectCode {
    code: string;
    agentName: string;
    tier: AgentTier;
    profileName: string | null;
    expiresAt: Date;
}
export declare function createConnectCode(agentName: string, tier: AgentTier, profileName?: string): Promise<ConnectCode>;
export declare function redeemConnectCode(code: string): Promise<RegisteredAgent>;
export declare const TIER_RULES: Record<AgentTier, {
    canWrite: boolean;
    canReadIdentity: boolean;
    identityCategoryFilter: string[] | null;
    profileScoped: boolean;
    canAnonymize: boolean;
    canRoute: boolean;
}>;
export declare function canAccess(context: AgentContext, action: 'write' | 'readIdentity' | 'anonymize' | 'route'): boolean;
//# sourceMappingURL=auth.d.ts.map