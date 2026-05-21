/**
 * Minimal Hono-compatible context adapter for HTTP CONNECT-decrypted requests.
 *
 * Our existing handlers (anthropic.ts, openai.ts) expect a Hono Context object.
 * This creates a minimal compatible shim from raw HTTP request data.
 */
/**
 * Create a minimal Hono-compatible context from raw request data.
 * The returned object satisfies the subset of the Hono Context interface
 * that our handlers actually use.
 */
export function makeHonoContext(method, path, headers, body) {
    const _body = body;
    return {
        req: {
            json: async () => _body,
            header: (name) => headers[name.toLowerCase()],
            method,
            path,
        },
        json: (data, status = 200) => {
            return new Response(JSON.stringify(data), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        // Minimal additional properties Hono context needs
        env: {},
        executionCtx: { waitUntil: () => { } },
        event: null,
        get: (_key) => undefined,
        set: (_key, _value) => { },
        var: {},
    };
}
//# sourceMappingURL=connect-context.js.map