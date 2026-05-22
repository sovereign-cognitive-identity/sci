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
        process.stderr.write(`[sci-auth-debug] auth header: ${(originalHeaders['authorization'] ?? 'NONE').slice(0,30)}
`);
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
 * Passes through the raw Anthropic SSE stream verbatim, only patching
 * `content_block_delta` events with `text_delta` type to deanonymize text.
 * All other events (tool_use, input_json_delta, message_start with real IDs,
 * token counts, stop_reason, etc.) are forwarded unchanged.
 *
 * `extra.prelude` is emitted BEFORE the first Anthropic event.
 * `extra.postlude` is emitted AFTER message_stop.
 */
export async function streamDirectAnthropic(path, requestBody, originalHeaders, deanonPush, deanonEnd, onComplete, extra) {
    const encoder = new TextEncoder();
    // Fetch from Anthropic BEFORE creating the ReadableStream so we can return
    // the correct HTTP status code for errors (rate_limit, auth, etc.).
    // The SDK correctly parses 4xx/5xx but fails on event: error in HTTP 200.
    let asyncStream;
    if (TUN_MODE || VPN_MODE) {
        asyncStream = await requestViaRealIP(path, requestBody, originalHeaders);
    }
    else {
        process.stderr.write(`[sci-auth-debug] auth header: ${(originalHeaders['authorization'] ?? 'NONE').slice(0,30)}
`);
        const response = await fetch(`https://${ANTHROPIC_HOSTNAME}${path}`, {
            method: 'POST',
            headers: { ...originalHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
            // Return the real HTTP error status so the SDK can parse it correctly.
            const errText = await response.text();
            onComplete();
            return new Response(errText, {
                status: response.status,
                headers: { 'content-type': 'application/json', 'x-sci-error': 'upstream' },
            });
        }
        if (!response.body)
            throw new Error('No response body from Anthropic');
        const reader = response.body.getReader();
        asyncStream = {
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
    return new ReadableStream({
        async start(controller) {
            // Sci transparency events first (clients that don't recognise them ignore them).
            if (extra?.prelude) {
                controller.enqueue(encoder.encode(extra.prelude));
            }
            try {
                // Parse SSE events (split on double-newline) and forward,
                // patching only text_delta events for deanonymization.
                const decoder = new TextDecoder();
                let buf = '';
                for await (const chunk of asyncStream) {
                    buf += decoder.decode(chunk, { stream: true });
                    // SSE events are separated by \n\n
                    const events = buf.split('\n\n');
                    buf = events.pop() ?? '';
                    for (const rawEvent of events) {
                        if (!rawEvent.trim())
                            continue;
                        // Extract event type and data line
                        let eventType = '';
                        let dataStr = '';
                        for (const line of rawEvent.split('\n')) {
                            if (line.startsWith('event: '))
                                eventType = line.slice(7);
                            else if (line.startsWith('data: '))
                                dataStr = line.slice(6);
                        }
                        if (!dataStr || dataStr === '[DONE]') {
                            controller.enqueue(encoder.encode(rawEvent + '\n\n'));
                            continue;
                        }
                        try {
                            const data = JSON.parse(dataStr);
                            if (data.type === 'content_block_delta' &&
                                data.delta?.type === 'text_delta' &&
                                typeof data.delta.text === 'string') {
                                // Deanonymize in-place; fall back to original if deanon buffers
                                const deanon = deanonPush(data.delta.text);
                                data.delta.text = deanon ?? data.delta.text;
                                const patched = (eventType ? `event: ${eventType}\n` : '') +
                                    `data: ${JSON.stringify(data)}\n\n`;
                                controller.enqueue(encoder.encode(patched));
                            }
                            else {
                                controller.enqueue(encoder.encode(rawEvent + '\n\n'));
                            }
                        }
                        catch {
                            controller.enqueue(encoder.encode(rawEvent + '\n\n'));
                        }
                    }
                }
                // Flush any remaining deanon buffer
                deanonEnd();
            }
            catch (err) {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } })}\n\n`));
            }
            // Postlude (sci.deanonymized stats) after the Anthropic stream ends.
            if (extra?.postlude) {
                const post = extra.postlude();
                if (post)
                    controller.enqueue(encoder.encode(post));
            }
            controller.close();
            onComplete();
        },
    });
}
//# sourceMappingURL=direct-anthropic.js.map