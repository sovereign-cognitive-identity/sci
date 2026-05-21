/**
 * Google Gemini API handler — POST /v1beta/models/{model}:streamGenerateContent
 *                              POST /v1beta/models/{model}:generateContent
 *
 * Generative Language API format:
 *   {
 *     "contents":          [{ "role": "user", "parts": [{ "text": "..." }] }],
 *     "systemInstruction": { "parts": [{ "text": "..." }] },
 *     "generationConfig":  { "maxOutputTokens": 1024 }
 *   }
 *
 * Streaming response (SSE-shaped when ?alt=sse):
 *   data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}
 *
 * Auth: API key as `?key=...` query param OR `x-goog-api-key` header.
 *
 * BYO model: Sci anonymizes locally, forwards with the user's own API key
 * (their billing, their account). For Sci-managed pool credentials, see
 * SCI-110 (cross-cutting credential resolver).
 */
import https from 'https';
import { anonymize } from '@sci/core';
import { DeanonymizingStreamV2 } from '../stream/deanonymizer.js';
import { storeInteraction } from '../middleware/memory.js';
import { resolveRealDirect } from '../dns-resolver.js';
const GOOGLE_HOSTNAME = 'generativelanguage.googleapis.com';
// ── Helpers ───────────────────────────────────────────────────────────────
/** Apply f to every text-bearing part in-place; return a new GeminiContent. */
function mapTextParts(content, f) {
    return {
        role: content.role,
        parts: content.parts.map(p => p.text !== undefined ? { ...p, text: f(p.text) } : p),
    };
}
function lastUserText(contents) {
    for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (c.role === 'user') {
            return c.parts.map(p => p.text ?? '').join('');
        }
    }
    return '';
}
function joinAllText(contents) {
    return contents
        .map(c => c.parts.map(p => p.text ?? '').join(''))
        .join('\n');
}
/**
 * Open the upstream Gemini stream. Throws GoogleUpstreamError on non-2xx so
 * the handler can mirror the upstream status to the client.
 */
export class GoogleUpstreamError extends Error {
    status;
    body;
    constructor(status, body) {
        super(`Gemini ${status}`);
        this.status = status;
        this.body = body;
        this.name = 'GoogleUpstreamError';
    }
}
async function openGoogleStream(opts) {
    const realIP = await resolveRealDirect(GOOGLE_HOSTNAME);
    const bodyStr = JSON.stringify(opts.body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: realIP,
            servername: GOOGLE_HOSTNAME,
            port: 443,
            path: opts.path,
            method: 'POST',
            headers: {
                ...opts.headers,
                'host': GOOGLE_HOSTNAME,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bodyStr),
            },
            rejectUnauthorized: true,
        }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 400) {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => reject(new GoogleUpstreamError(status, Buffer.concat(chunks).toString())));
                res.on('error', reject);
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}
// ── Handler ───────────────────────────────────────────────────────────────
/**
 * Handles a Gemini generateContent / streamGenerateContent request.
 *
 * The handler is mounted by the TLS interceptor (server-tls.ts) when the SNI
 * matches `generativelanguage.googleapis.com`. The path comes through verbatim
 * from the original request URL.
 */
export async function handleGoogleGemini(c, adapter) {
    const t0 = Date.now();
    const reqId = `req_${Math.random().toString(36).slice(2, 11)}`;
    const path = c.req.path + (c.req.raw.url.includes('?') ? c.req.raw.url.slice(c.req.raw.url.indexOf('?')) : '');
    const isStreaming = path.includes(':streamGenerateContent');
    const body = await c.req.json();
    const originalUserText = lastUserText(body.contents);
    process.stderr.write(`[${reqId}] ── incoming google (${path.split('/').pop()?.split('?')[0]}, ${body.contents.length} contents)\n`);
    // 1. Anonymize all text in `contents[]` and `systemInstruction`
    let sessionTokenMap = { forward: new Map(), reverse: new Map() };
    const anonContents = body.contents.map(c0 => {
        return mapTextParts(c0, (text) => {
            const r = anonymize(text, sessionTokenMap);
            sessionTokenMap = r.tokenMap;
            return r.text;
        });
    });
    const anonSystem = body.systemInstruction
        ? {
            parts: body.systemInstruction.parts.map(p => {
                if (p.text === undefined)
                    return p;
                const r = anonymize(p.text, sessionTokenMap);
                sessionTokenMap = r.tokenMap;
                return { ...p, text: r.text };
            }),
        }
        : undefined;
    if (sessionTokenMap.forward.size > 0) {
        process.stderr.write(`[${reqId}] 🔒 masked ${sessionTokenMap.forward.size} entities\n`);
    }
    // 2. Memory injection — for now, gemini path skips memory recall (the
    //    injectMemoryContext helper is OpenRouter/Anthropic-shaped). Memory
    //    recall for Gemini is a follow-up: reuse @sci/core embeddings + recall,
    //    inject as a prefix on `systemInstruction`. Keeping the path narrow
    //    for now so we ship a working baseline tonight; SCI-110 follow-up.
    // 3. Forward to real Gemini API with the caller's auth (BYO key)
    process.stderr.write(`[${reqId}] → ${GOOGLE_HOSTNAME} (gemini)\n`);
    const forwardHeaders = {};
    // Pass through Google-specific auth headers
    const apiKey = c.req.header('x-goog-api-key');
    if (apiKey)
        forwardHeaders['x-goog-api-key'] = apiKey;
    const auth = c.req.header('authorization');
    if (auth)
        forwardHeaders['authorization'] = auth;
    let upstream;
    try {
        upstream = await openGoogleStream({
            path,
            body: { ...body, contents: anonContents, ...(anonSystem ? { systemInstruction: anonSystem } : {}) },
            headers: forwardHeaders,
        });
    }
    catch (err) {
        if (err instanceof GoogleUpstreamError) {
            process.stderr.write(`[${reqId}] ✗  upstream ${err.status}: ${err.body.slice(0, 200)}\n`);
            let parsed = null;
            try {
                parsed = JSON.parse(err.body);
            }
            catch { /* fall through */ }
            if (parsed && typeof parsed === 'object') {
                return c.json(parsed, err.status);
            }
            return c.text(err.body, err.status, { 'content-type': 'text/plain' });
        }
        process.stderr.write(`[${reqId}] ✗  proxy error: ${String(err)}\n`);
        return c.json({ error: { code: 502, message: `Sci proxy: ${String(err)}` } }, 502);
    }
    // 4. Stream back, deanonymizing text in candidates[].content.parts[].text
    const deanonStream = new DeanonymizingStreamV2(sessionTokenMap);
    if (!isStreaming) {
        // Buffered (non-streaming) — read all, transform, return JSON.
        const chunks = [];
        for await (const chunk of upstream)
            chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return c.text(raw, 200, { 'content-type': 'application/json' });
        }
        if (parsed.candidates) {
            for (const cand of parsed.candidates) {
                if (cand.content?.parts) {
                    for (const part of cand.content.parts) {
                        if (part.text)
                            part.text = deanonStream.push(part.text) + deanonStream.end();
                    }
                }
            }
        }
        process.stderr.write(`[${reqId}] ✓  complete in ${Date.now() - t0}ms\n`);
        storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => { });
        return c.json(parsed);
    }
    // Streaming — Gemini's streaming format is JSON-array-of-chunks (with `?alt=sse`,
    // each chunk is wrapped as `data: {...}\n\n`). We re-stream verbatim, only
    // rewriting the text fields in candidates[].content.parts[].
    const decoder = new TextDecoder();
    let buf = '';
    const transformChunk = (chunkJson) => {
        if (!chunkJson.candidates)
            return chunkJson;
        for (const cand of chunkJson.candidates) {
            if (cand.content?.parts) {
                for (const part of cand.content.parts) {
                    if (typeof part.text === 'string') {
                        part.text = deanonStream.push(part.text);
                    }
                }
            }
        }
        return chunkJson;
    };
    const readable = new ReadableStream({
        async start(controller) {
            const enc = new TextEncoder();
            try {
                for await (const chunk of upstream) {
                    buf += decoder.decode(chunk, { stream: true });
                    // Split on lines; Gemini's SSE format is `data: <json>\n\n`. Without
                    // ?alt=sse it's a JSON array streamed as `[<chunk>,<chunk>,...]`.
                    // Handle both: try JSON-line first, fall back to raw passthrough.
                    let nl;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        const trimmed = line.trim().replace(/^data:\s*/, '');
                        if (!trimmed || trimmed === '[' || trimmed === ']' || trimmed === ',') {
                            // Pass through structural characters as-is
                            controller.enqueue(enc.encode(line + '\n'));
                            continue;
                        }
                        // Strip trailing comma if present (JSON array element)
                        const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            const transformed = transformChunk(parsed);
                            const out = line.startsWith('data:')
                                ? `data: ${JSON.stringify(transformed)}\n`
                                : JSON.stringify(transformed) + (trimmed.endsWith(',') ? ',' : '') + '\n';
                            controller.enqueue(enc.encode(out));
                        }
                        catch {
                            // Not parseable — pass through verbatim
                            controller.enqueue(enc.encode(line + '\n'));
                        }
                    }
                }
                // Drain any tail buffered in the deanonymizer.
                const tail = deanonStream.end();
                if (tail && buf.trim()) {
                    // Tail-flush is awkward in the middle of streaming JSON; safest to
                    // emit it in a synthetic final chunk only if we still have a buffer.
                    controller.enqueue(enc.encode(buf));
                }
            }
            catch (err) {
                controller.enqueue(enc.encode(`\n{"error":{"message":"${String(err).replace(/"/g, '\\"')}"}}\n`));
            }
            process.stderr.write(`[${reqId}] ✓  complete in ${Date.now() - t0}ms\n`);
            storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => { });
            controller.close();
        },
    });
    return new Response(readable, {
        headers: {
            'Content-Type': c.req.header('accept')?.includes('text/event-stream') ? 'text/event-stream' : 'application/json',
            'Cache-Control': 'no-cache',
            'X-Sci-Mode': 'direct',
            'X-Sci-Provider': 'google',
        },
    });
}
//# sourceMappingURL=google.js.map