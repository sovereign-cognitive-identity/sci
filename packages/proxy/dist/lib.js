/**
 * Library entry point — provider-aware request handlers + context shim,
 * importable from outside the proxy server.
 *
 * Used by:
 *   - `@sci/proxy` itself (server-tls.ts and the Hono routes)
 *   - `@sci/agent` (the local on-device CLI agent)
 *
 * Keeping this surface narrow on purpose. The proxy *server* binary lives
 * in index.ts and pulls in Hono + Postgres adapter + TLS interception
 * server. None of that is needed by callers that just want to anonymize +
 * forward an AI provider request — those callers import from here.
 *
 * Exports are stable; treat this file as the contract `@sci/agent` and
 * any future consumer compiles against.
 */
export { handleAnthropicMessages } from './handlers/anthropic.js';
export { handleOpenAIChat } from './handlers/openai.js';
export { handleGoogleGemini } from './handlers/google.js';
export { makeHandlerContext, pipeResponse, ANONYMOUS_AGENT, } from './handler-context.js';
//# sourceMappingURL=lib.js.map