/**
 * Audit log — every meaningful action that touches user data lands here so
 * the dashboard can show "what happened on my account, when, by which
 * device". Writes are best-effort and async (catch and ignore failures).
 */
import { writer, reader } from './db.js';
export async function audit(entry) {
    try {
        await writer.query(`INSERT INTO audit_log (user_id, agent_id, device_id, action, target, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            entry.userId ?? null,
            entry.agentId ?? null,
            entry.deviceId ?? null,
            entry.action,
            entry.target ?? null,
            entry.outcome ?? 'ok',
            JSON.stringify(entry.metadata ?? {}),
        ]);
    }
    catch (e) {
        // Never throw from audit — logging must never block the request path.
        console.error('[audit] insert failed:', e.message, 'action=', entry.action, 'agentId=', entry.agentId, 'userId=', entry.userId, 'deviceId=', entry.deviceId, 'target=', entry.target);
    }
}
export async function queryAudit(q) {
    const conds = [];
    const params = [];
    if (q.userId) {
        conds.push(`user_id = $${conds.length + 1}`);
        params.push(q.userId);
    }
    if (q.agentId) {
        conds.push(`agent_id = $${conds.length + 1}`);
        params.push(q.agentId);
    }
    if (q.deviceId) {
        conds.push(`device_id = $${conds.length + 1}`);
        params.push(q.deviceId);
    }
    if (q.action) {
        conds.push(`action = $${conds.length + 1}`);
        params.push(q.action);
    }
    if (q.before) {
        conds.push(`created_at < $${conds.length + 1}`);
        params.push(q.before);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    params.push(limit);
    const { rows } = await reader.query(`SELECT id::text, user_id, agent_id, device_id, action, target, outcome,
            metadata, created_at
     FROM audit_log ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`, params);
    return rows.map(r => ({
        id: r.id, userId: r.user_id, agentId: r.agent_id, deviceId: r.device_id,
        action: r.action, target: r.target, outcome: r.outcome,
        metadata: r.metadata ?? {},
        createdAt: r.created_at,
    }));
}
//# sourceMappingURL=audit.js.map