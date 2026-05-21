/**
 * Direct Anthropic forwarding — preserves your claude.ai subscription.
 *
 * In 'direct' mode the proxy:
 *   1. Anonymizes messages
 *   2. Injects memory context
 *   3. Forwards to api.anthropic.com with the ORIGINAL Authorization header
 *   4. Streams back Anthropic SSE, deanonymizes text deltas on the fly
 *   5. Stores interaction to memory
 *
 * No OpenRouter involved. Your subscription usage counts normally.
 * You lose multi-model routing — everything stays on the Claude model requested.
 */
import https from 'https';
import { resolveRealDirect } from './dns-resolver.js';
import { getPhysicalInterfaceIP } from './physical-iface.js';
const ANTHROPIC_HOSTNAME = 'api.anthropic.com';
const VPN_MODE = process.env['SCI_VPN_MODE'] === 'true';
const TUN_MODE = process.env['SCI_TUN_MODE'] === 'true';
/**
 * In VPN/TUN mode we must connect to the REAL IP to avoid routing loops,
 * but we need TLS to validate against the HOSTNAME (not the IP).
 * fetch() can't do this — use https.request() with separate host/servername.
 *
 * Plus: bind to the physical interface's IP (localAddress) so the kernel
 * routes via en0 even when the destination IP has a more-specific route
 * pointing at utun5 (this is what lets us route real AI IPs through the TUN
 * without our own outbound looping back through it).
 *
 * Returns an IncomingMessage (streaming) so the caller can parse SSE.
 */
async function requestViaRealIP(path, body, originalHeaders) {
    const realIP = await resolveRealDirect(ANTHROPIC_HOSTNAME);
    const localAddress = TUN_MODE ? (getPhysicalInterfaceIP() ?? undefined) : undefined;
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const req = https.request({
            host: realIP, // TCP: connect to real IP (bypasses /etc/hosts)
            servername: ANTHROPIC_HOSTNAME, // TLS SNI: validate cert against hostname
            localAddress, // Source IP: bypasses TUN route for outbound
            port: 443,
            path,
            method: 'POST',
            headers: {
                ...originalHeaders,
                'content-type': 'application/json',
                'host': ANTHROPIC_HOSTNAME,
                'content-length': Buffer.byteLength(bodyStr),
            },
            rejectUnauthorized: true,
        }, resolve);
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}
/** Async generator of text deltas from a direct Anthropic SSE stream. */
export async function* streamFromAnthropic(path, body, originalHeaders) {
    let stream;
    if (TUN_MODE || VPN_MODE) {
        // Must use real IP + SNI to avoid routing loop — fetch() can't do this
        const res = await requestViaRealIP(path, body, originalHeaders);
        if ((res.statusCode ?? 0) >= 400) {
            const chunks = [];
            for await (const c of res)
                chunks.push(c);
            throw new Error(`Anthropic ${res.statusCode}: ${Buffer.concat(chunks).toString()}`);
        }
        stream = res;
    }
    else {
        // Normal mode: fetch works fine, no routing concern
        const response = await fetch(`https://${ANTHROPIC_HOSTNAME}${path}`, {
            method: 'POST',
            headers: { ...originalHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic ${response.status}: ${err}`);
        }
        if (!response.body)
            throw new Error('No response body from Anthropic');
        // Convert ReadableStream to AsyncIterable
        const reader = response.body.getReader();
        stream = {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        const { done, value } = await reader.read();
                        return done ? { done: true, value: undefined } : { done: false, value: Buffer.from(value) };
                    }
                };
            }
        };
    }
    // Parse SSE stream
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':'))
                continue;
            if (trimmed.startsWith('data: ')) {
                const json = trimmed.slice(6);
                if (json === '[DONE]')
                    return;
                try {
                    const chunkData = JSON.parse(json);
                    if (chunkData.type === 'content_block_delta' &&
                        chunkData.delta?.type === 'text_delta' &&
                        chunkData.delta.text) {
                        yield chunkData.delta.text;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
    }
}
/**
 * Re-stream a direct Anthropic response as Anthropic SSE with deanonymization.
 *
 * `extra.prelude` is emitted as raw SSE bytes BEFORE message_start. We use
 * this to surface Sci-specific transparency events (`sci.anonymized`, etc.)
 * that downstream Anthropic-compatible clients ignore. Standards-compliant
 * SSE parsers skip events whose `event:` name they don't recognise.
 *
 * `extra.postlude` is called once the deanonymizer has fully drained — its
 * return value is emitted before content_block_stop. This is where we put
 * `sci.deanonymized` since the replacement counts only exist after the
 * stream completes.
 */
export async function streamDirectAnthropic(path, requestBody, originalHeaders, deanonPush, deanonEnd, onComplete, extra) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            const msgId = `msg_${Date.now()}`;
            const emit = (event, data) => {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            // Sci transparency events first (clients that don't know them ignore them).
            if (extra?.prelude) {
                controller.enqueue(encoder.encode(extra.prelude));
            }
            emit('message_start', {
                type: 'message_start',
                message: { id: msgId, type: 'message', role: 'assistant', content: [], stop_reason: null },
            });
            emit('content_block_start', {
                type: 'content_block_start', index: 0,
                content_block: { type: 'text', text: '' },
            });
            try {
                for await (const delta of streamFromAnthropic(path, requestBody, originalHeaders)) {
                    const safe = deanonPush(delta);
                    if (safe) {
                        emit('content_block_delta', {
                            type: 'content_block_delta', index: 0,
                            delta: { type: 'text_delta', text: safe },
                        });
                    }
                }
                const final = deanonEnd();
                if (final) {
                    emit('content_block_delta', {
                        type: 'content_block_delta', index: 0,
                        delta: { type: 'text_delta', text: final },
                    });
                }
            }
            catch (err) {
                emit('error', { type: 'error', error: { type: 'api_error', message: String(err) } });
            }
            // Postlude fires after deanonymization fully drains, before message_stop.
            // Stats like `replacementCount` are now known.
            if (extra?.postlude) {
                const post = extra.postlude();
                if (post)
                    controller.enqueue(encoder.encode(post));
            }
            emit('content_block_stop', { type: 'content_block_stop', index: 0 });
            emit('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 },
            });
            emit('message_stop', { type: 'message_stop' });
            controller.close();
            onComplete();
        },
    });
}
//# sourceMappingURL=direct-anthropic.js.map