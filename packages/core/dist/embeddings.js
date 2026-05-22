// BGEBaseENV15: 768-dim, matches schema. Nomic requires fastembed >=2.x.
export const MODEL_ID = process.env['SCI_EMBED_MODEL'] ?? 'BAAI/bge-base-en-v1.5';
export const DIMENSIONS = 768;
import { Worker, isMainThread, parentPort, workerData, receiveMessageOnPort, MessageChannel } from 'worker_threads';
import { fileURLToPath } from 'url';
// Run ONNX inference on a dedicated worker thread to avoid blocking the main
// event loop. A blocked event loop stalls the HTTP server's CONNECT tunnel
// I/O, causing Anthropic to see a connection stall and return 429.
let _worker = null;
let _pendingEmbeds = new Map();
let _embedCounter = 0;
function getWorker() {
    if (_worker)
        return _worker;
    const workerCode = `
import { parentPort } from 'worker_threads';
import { FlagEmbedding, EmbeddingModel } from 'fastembed';
let model = null;
async function init(cacheDir) {
    model = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        ...(cacheDir ? { cacheDir } : {}),
    });
}
const cacheDir = process.env.SCI_FASTEMBED_CACHE_DIR;
init(cacheDir).then(() => parentPort.postMessage({ type: 'ready' }));
parentPort.on('message', async ({ id, text }) => {
    const vector = await model.queryEmbed(text);
    parentPort.postMessage({ type: 'result', id, vector: Array.from(vector) });
});
`;
    _worker = new Worker(workerCode, { eval: true });
    _worker.on('message', ({ type, id, vector }) => {
        if (type === 'result' && _pendingEmbeds.has(id)) {
            const { resolve } = _pendingEmbeds.get(id);
            _pendingEmbeds.delete(id);
            resolve(vector);
        }
    });
    _worker.on('error', (err) => {
        for (const { reject } of _pendingEmbeds.values()) reject(err);
        _pendingEmbeds.clear();
        _worker = null;
    });
    return _worker;
}
let _model = null;
async function getModel() {
    if (_model)
        return _model;
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    const cacheDir = process.env['SCI_FASTEMBED_CACHE_DIR'];
    _model = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        ...(cacheDir ? { cacheDir } : {}),
    });
    return _model;
}
export async function embed(text) {
    // Run ONNX inference on a worker thread to avoid blocking the event loop.
    if (isMainThread) {
        const worker = getWorker();
        const id = ++_embedCounter;
        return new Promise((resolve, reject) => {
            _pendingEmbeds.set(id, { resolve, reject });
            worker.postMessage({ id, text });
        });
    }
    // Fallback: running inside a worker already, use model directly.
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