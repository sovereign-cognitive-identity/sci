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
export declare function makeHonoContext(method: string, path: string, headers: Record<string, string>, body: unknown): {
    req: {
        json: () => Promise<unknown>;
        header: (name: string) => string;
        method: string;
        path: string;
    };
    json: (data: unknown, status?: number) => import("undici-types").Response;
    env: {};
    executionCtx: {
        waitUntil: () => void;
    };
    event: null;
    get: (_key: string) => undefined;
    set: (_key: string, _value: unknown) => void;
    var: {};
};
//# sourceMappingURL=connect-context.d.ts.map