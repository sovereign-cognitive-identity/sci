const DECAY_FLAG_THRESHOLD = 0.15;
export function calculateDecay(confidence, accessCount, lastAccessedAt, now = new Date()) {
    const daysSinceAccess = (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24);
    const stability = 1 + accessCount * 0.5;
    const retention = Math.exp(-daysSinceAccess / stability);
    return Math.max(0, confidence * retention);
}
export async function runDecayPass(adapter) {
    const now = new Date();
    const profiles = await adapter.getProfiles();
    let updated = 0;
    let flagged = 0;
    for (const profile of profiles) {
        const nodes = await adapter.getSemanticNodes(profile.id, {});
        for (const node of nodes) {
            const newScore = calculateDecay(node.confidence, node.access_count, new Date(node.last_accessed_at), now);
            const nowFlagged = newScore < DECAY_FLAG_THRESHOLD;
            const wasFlagged = node.decay_score < DECAY_FLAG_THRESHOLD;
            await adapter.updateDecayScore(node.id, newScore, nowFlagged);
            updated++;
            if (nowFlagged && !wasFlagged)
                flagged++;
        }
    }
    return {
        updated,
        flagged,
        summary: `Decay pass: ${updated} nodes updated, ${flagged} newly flagged (score < ${DECAY_FLAG_THRESHOLD})`,
    };
}
//# sourceMappingURL=decay.js.map