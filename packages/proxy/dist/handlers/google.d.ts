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
import type { Context } from 'hono';
import type { StorageAdapter } from '@sci/core';
/**
 * Open the upstream Gemini stream. Throws GoogleUpstreamError on non-2xx so
 * the handler can mirror the upstream status to the client.
 */
export declare class GoogleUpstreamError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string);
}
/**
 * Handles a Gemini generateContent / streamGenerateContent request.
 *
 * The handler is mounted by the TLS interceptor (server-tls.ts) when the SNI
 * matches `generativelanguage.googleapis.com`. The path comes through verbatim
 * from the original request URL.
 */
export declare function handleGoogleGemini(c: Context, adapter: StorageAdapter): Promise<Response>;
//# sourceMappingURL=google.d.ts.map