export type AuditAction = 'auth.login' | 'auth.logout' | 'auth.failed' | 'user.create' | 'profile.create' | 'device.add' | 'device.revoke' | 'device.rotate_token' | 'memory.recall' | 'memory.store' | 'memory.identity' | 'proxy.request' | 'proxy.denied' | 'gateway.peer_sync' | 'rate_limit.exceeded';
export interface AuditEntry {
    userId?: string | null;
    agentId?: string | null;
    deviceId?: string | null;
    action: AuditAction;
    target?: string | null;
    outcome?: 'ok' | 'denied' | 'error';
    metadata?: Record<string, unknown>;
}
export declare function audit(entry: AuditEntry): Promise<void>;
export interface AuditQuery {
    userId?: string;
    agentId?: string;
    deviceId?: string;
    action?: string;
    limit?: number;
    before?: Date;
}
export interface AuditRow {
    id: string;
    userId: string | null;
    agentId: string | null;
    deviceId: string | null;
    action: string;
    target: string | null;
    outcome: string;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
export declare function queryAudit(q: AuditQuery): Promise<AuditRow[]>;
//# sourceMappingURL=audit.d.ts.map