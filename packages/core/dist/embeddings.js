// BGEBaseENV15: 768-dim, matches schema. Nomic requires fastembed >=2.x.
export const MODEL_ID = process.env['SCI_EMBED_MODEL'] ?? 'BAAI/bge-base-en-v1.5';
export const DIMENSIONS = 768;
let _model = null;
async function getModel() {
    if (_model)
        return _model;
    // Dynamic import so Bun compiled binaries resolve fastembed from the real
    // filesystem (process.cwd() / binary dir) rather than the virtual $bunfs.
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    // Where to put the BGE model files. Defaults to fastembed's `./local_cache`
    // relative to CWD — fine on developer laptops, broken inside Docker
    // containers where the working dir is owned by root and the process runs
    // as a non-root user. Set SCI_FASTEMBED_CACHE_DIR to redirect somewhere
    // writable (e.g. a mounted volume).
    const cacheDir = process.env['SCI_FASTEMBED_CACHE_DIR'];
    _model = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        ...(cacheDir ? { cacheDir } : {}),
    });
    return _model;
}
export async function embed(text) {
    const model = await getModel();
    const vector = await model.queryEmbed(text);
    return Array.from(vector);
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
//# sourceMappingURL=embeddings.js.map