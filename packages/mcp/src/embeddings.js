import { FlagEmbedding, EmbeddingModel } from 'fastembed';
const MODEL_ID = process.env['SCI_EMBED_MODEL'] ?? 'nomic-embed-text-v1.5';
const DIMENSIONS = 768;
let _model = null;
async function getModel() {
    if (_model)
        return _model;
    _model = await FlagEmbedding.init({
        model: EmbeddingModel.NomicEmbedTextV15,
    });
    return _model;
}
export async function embed(text) {
    const model = await getModel();
    const results = model.queryEmbed(text);
    // queryEmbed returns an async generator — take the first (and only) result
    for await (const vector of results) {
        return Array.from(vector);
    }
    throw new Error('Embedding model returned no results');
}
export async function embedBatch(texts) {
    const model = await getModel();
    const vectors = [];
    for await (const batch of model.embed(texts, 32)) {
        for (const vector of batch) {
            vectors.push(Array.from(vector));
        }
    }
    return vectors;
}
export { MODEL_ID, DIMENSIONS };
//# sourceMappingURL=embeddings.js.map