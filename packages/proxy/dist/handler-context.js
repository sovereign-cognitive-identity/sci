/**
 * Default agent context for callers that have no per-user identity (the
 * single-user agent case, or single-tenant Hub mode where source-IP
 * identity resolution doesn't apply). Anonymization + memory-recall still
 * run against the default profile.
 */
export const ANONYMOUS_AGENT = {
    agentId: '00000000-0000-0000-0000-000000000000',
    agentName: 'anonymous-local',
    tier: 'trusted',
    profileId: null,
};
/**
 * Build a Hono-Context-shaped object from a Node IncomingMessage + a
 * buffered request body + an agent identity. The returned shape implements
 * just enough of Hono's Context interface for the existing handlers to
 * work: `c.req.json()`, `c.req.header()`, `c.req.path`, `c.req.method`,
 * `c.req.raw`, `c.var`, `c.get()`, `c.set()`, `c.json()`, `c.text()`,
 * `c.res`, `c.header()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeHandlerContext(req, body, agent) {
    const headerLookup = (name) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    // The Google handler reads `c.req.raw.url` to grab the full request path
    // including query string. Provide that. signal is a stub — abort plumbing
    // can be wired through if a handler needs it.
    const rawShim = {
        url: req.url ?? '/',
        headers: req.headers,   // expose full headers for forwarding to upstream
        signal: { addEventListener: () => { } },
    };
    const ctx = {
        req: {
            json: () => Promise.resolve(JSON.parse(body.toString('utf-8'))),
            header: headerLookup,
            path: (req.url ?? '/').split('?')[0] ?? '/',
            method: req.method ?? 'POST',
            raw: rawShim,
        },
        var: { agent, deviceId: null, userId: null },
        get: (key) => {
            if (key === 'agent')
                return agent;
            if (key === 'deviceId')
                return null;
            if (key === 'userId')
                return null;
            return undefined;
        },
        set: (_key, _value) => { },
        header: (_name, _value) => { },
        json: (data, status = 200) => new Response(JSON.stringify(data), {
            status,
            headers: { 'content-type': 'application/json' },
        }),
        text: (text, status = 200, headers = {}) => new Response(text, { status, headers }),
        res: { status: 200, headers: new Headers() },
    };
    return ctx;
}
/**
 * Pipe a handler's return value (a Web Response, or a c.json()-shaped
 * fallback) into a Node ServerResponse. Used by both the proxy server's
 * TLS-interception path and the local agent.
 */
export async function pipeResponse(result, res) {
    if (result instanceof Response) {
        const headers = {};
        result.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(result.status, headers);
        if (result.body) {
            const reader = result.body.getReader();
            let totalBytes = 0;
            let chunkCount = 0;
            const reqPath = res.req?.url ?? '?';
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value) {
                        if (chunkCount === 0) {
                            process.stderr.write(`[sci-pipe] first chunk for ${reqPath}: ${value.length}b, starts: ${Buffer.from(value).toString('utf8').slice(0,40).replace(/\n/g,'↵')}\n`);
                        }
                        totalBytes += value.length;
                        chunkCount++;
                        const ok = res.write(Buffer.from(value));
                        if (!ok && chunkCount === 1) {
                            process.stderr.write(`[sci-pipe] backpressure on first chunk for ${reqPath}\n`);
                        }
                    }
                }
                process.stderr.write(`[sci-pipe] done ${reqPath}: ${chunkCount} chunks, ${totalBytes}b\n`);
            } catch (pipeErr) {
                process.stderr.write(`[sci-pipe] write error after ${totalBytes}b: ${pipeErr.message}\n`);
            }
        }
        res.end();
        return;
    }
    const r = result;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(r.body ?? JSON.stringify(r));
}
//# sourceMappingURL=handler-context.js.map