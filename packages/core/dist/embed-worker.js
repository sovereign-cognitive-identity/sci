// Worker thread for fastembed ONNX inference — keeps the main event loop free.
import { parentPort } from 'worker_threads';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve fastembed from the sci root node_modules regardless of cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
const fastembedPath = join(__dirname, '../../../node_modules/fastembed/lib/esm/index.js');
const { FlagEmbedding, EmbeddingModel } = await import(fastembedPath);

let model = null;
async function init(cacheDir) {
    model = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        ...(cacheDir ? { cacheDir } : {}),
    });
}

const cacheDir = process.env.SCI_FASTEMBED_CACHE_DIR;
await init(cacheDir);
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async ({ id, text }) => {
    const vector = await model.queryEmbed(text);
    parentPort.postMessage({ type: 'result', id, vector: Array.from(vector) });
});
