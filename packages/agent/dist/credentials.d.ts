export interface Credentials {
    anthropic?: string;
    openai?: string;
    openrouter?: string;
    google?: string;
}
/**
 * Read the agent's credential bundle. Logs (to stderr) a one-time summary
 * of which providers are configured at startup so the user can confirm
 * Sci is seeing what they expect — without ever logging the key bytes.
 */
export declare function loadCredentials(configDir: string): Credentials;
/** One-line stderr summary of which provider keys are configured. */
export declare function summarizeCredentials(creds: Credentials): string;
/**
 * Each provider wants its credential in a different header. Sci's job at
 * dispatch time is to make sure the buffered `IncomingMessage`'s headers
 * carry the right one — the existing handlers in `@sci/proxy/handlers`
 * read whichever convention applies to the upstream they're forwarding to.
 *
 * Mutating `req.headers` in place is the cleanest path: the
 * `makeHandlerContext` shim reads from `req.headers`, the handler reads
 * via `c.req.header(name)`, and both see the injected value without any
 * special plumbing.
 */
export declare function injectCredentialForHost(hostname: string, reqHeaders: NodeJS.Dict<string | string[]>, creds: Credentials): void;
