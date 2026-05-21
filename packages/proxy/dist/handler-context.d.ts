/**
 * Hono-shaped context shim built from a Node IncomingMessage + buffered body.
 *
 * The provider handlers in `./handlers/*.ts` were originally written to take
 * a Hono `Context`. Both the TLS-intercepting server (server-tls.ts) AND
 * the local agent (`@sci/agent`) need to invoke the handlers from a Node
 * http.IncomingMessage path, so we build a minimal Context-compatible
 * adapter here and share it.
 *
 * SCI-117 — extracted from server-tls.ts so `@sci/agent` can reuse without
 * importing the whole proxy server.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { AgentContext } from '@sci/core';
/**
 * Default agent context for callers that have no per-user identity (the
 * single-user agent case, or single-tenant Hub mode where source-IP
 * identity resolution doesn't apply). Anonymization + memory-recall still
 * run against the default profile.
 */
export declare const ANONYMOUS_AGENT: AgentContext;
/**
 * Build a Hono-Context-shaped object from a Node IncomingMessage + a
 * buffered request body + an agent identity. The returned shape implements
 * just enough of Hono's Context interface for the existing handlers to
 * work: `c.req.json()`, `c.req.header()`, `c.req.path`, `c.req.method`,
 * `c.req.raw`, `c.var`, `c.get()`, `c.set()`, `c.json()`, `c.text()`,
 * `c.res`, `c.header()`.
 */
export declare function makeHandlerContext(req: IncomingMessage, body: Buffer, agent: AgentContext): any;
/**
 * Pipe a handler's return value (a Web Response, or a c.json()-shaped
 * fallback) into a Node ServerResponse. Used by both the proxy server's
 * TLS-interception path and the local agent.
 */
export declare function pipeResponse(result: unknown, res: ServerResponse): Promise<void>;
//# sourceMappingURL=handler-context.d.ts.map