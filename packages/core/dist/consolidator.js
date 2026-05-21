import { embed } from './embeddings.js';
const SIMILARITY_THRESHOLD = 0.88;
const BATCH_SIZE = 20;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
async function llmCall(system, user, model, apiKey) {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/sovereign-cognitive-identity/sci',
            'X-Title': 'Sci Consolidator',
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature: 0.1,
            max_tokens: 1024,
        }),
    });
    if (!res.ok)
        throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0]?.message?.content?.trim() ?? '';
}
function parseJson(raw) {
    const clean = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    try {
        return JSON.parse(clean);
    }
    catch {
        return null;
    }
}
const PROMOTION_SYSTEM = `You are a knowledge distiller. Given a batch of raw messages a person wrote to AI assistants, extract durable semantic facts worth keeping long-term.

Output ONLY a JSON array. Each item:
{ "content": "concise declarative fact", "category": "fact"|"preference"|"decision"|"project"|"relationship"|"skill", "confidence": 0.5-1.0 }

Rules: only extract clearly stated facts; omit noise; aim for 2-6 facts; return [].`;
export async function runPromotionPass(windowStart, windowEnd, profileId, apiKey, model, adapter) {
    const memories = await adapter.getEpisodicMemoriesInWindow({
        profileId, windowStart, windowEnd, minLength: 20, limit: 2000,
    });
    if (memories.length === 0)
        return { promoted: 0, reinforced: 0, batches: 0 };
    let promoted = 0, reinforced = 0, batches = 0;
    for (let i = 0; i < memories.length; i += BATCH_SIZE) {
        const batch = memories.slice(i, i + BATCH_SIZE);
        const userPrompt = batch.map((m, j) => `${j + 1}. ${m.content.slice(0, 400)}`).join('\n');
        let facts = [];
        try {
            const raw = await llmCall(PROMOTION_SYSTEM, userPrompt, model, apiKey);
            facts = parseJson(raw) ?? [];
        }
        catch (err) {
            console.error(`  [promotion] batch ${batches + 1} LLM error:`, err instanceof Error ? err.message : err);
        }
        for (const fact of facts) {
            if (!fact.content || typeof fact.confidence !== 'number')
                continue;
            const embedding = await embed(fact.content);
            const similar = await adapter.findSimilarSemanticNode(embedding, profileId, SIMILARITY_THRESHOLD);
            if (similar) {
                await adapter.reinforceSemantic(similar.id);
                reinforced++;
            }
            else {
                await adapter.storeSemantic({
                    content: fact.content, profileId,
                    embedding,
                    category: fact.category ?? 'fact',
                    confidence: Math.min(1.0, Math.max(0.1, fact.confidence)),
                    metadata: { source: 'consolidation', window_start: windowStart.toISOString() },
                });
                promoted++;
            }
        }
        batches++;
        process.stdout.write(`\r  [promotion] ${batches}/${Math.ceil(memories.length / BATCH_SIZE)} batches — ${promoted} promoted, ${reinforced} reinforced   `);
    }
    process.stdout.write('\n');
    return { promoted, reinforced, batches };
}
const GRAPH_SYSTEM = `You are a knowledge graph builder. Given a list of semantic facts, identify meaningful relationships.

Output ONLY a JSON array:
{ "source": "exact text", "target": "exact text", "relationship": "relates_to"|"motivates"|"contradicts"|"part_of"|"enables", "confidence": 0.5-1.0 }

Max 10 relationships. Both source and target must be verbatim strings from the input. Return [].`;
export async function runGraphPass(profileId, apiKey, model, adapter) {
    const nodes = await adapter.getSemanticNodesForGraph(profileId, { minConfidence: 0.6, minDecay: 0.3, limit: 40 });
    if (nodes.length < 3)
        return { edges_created: 0 };
    const nodeList = nodes.map((n, i) => `${i + 1}. ${n.content}`).join('\n');
    const contentToId = new Map(nodes.map(n => [n.content, n.id]));
    let edges = [];
    try {
        const raw = await llmCall(GRAPH_SYSTEM, nodeList, model, apiKey);
        edges = parseJson(raw) ?? [];
    }
    catch (err) {
        console.error('  [graph] LLM error:', err instanceof Error ? err.message : err);
        return { edges_created: 0 };
    }
    let edgesCreated = 0;
    for (const edge of edges) {
        const sourceId = contentToId.get(edge.source);
        const targetId = contentToId.get(edge.target);
        if (!sourceId || !targetId || sourceId === targetId)
            continue;
        if (!edge.relationship || typeof edge.confidence !== 'number')
            continue;
        try {
            await adapter.insertSemanticEdge(sourceId, targetId, edge.relationship, edge.confidence);
            edgesCreated++;
        }
        catch { /* non-fatal */ }
    }
    return { edges_created: edgesCreated };
}
//# sourceMappingURL=consolidator.js.map