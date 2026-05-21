/**
 * OpenAI Chat Completions handler — POST /v1/chat/completions
 *
 * Handles requests from Cursor, Copilot, and any OpenAI-compatible client.
 * Same pipeline as the Anthropic handler but in/out format stays OpenAI.
 *
 * OpenAI SSE format:
 *   data: {"choices":[{"delta":{"content":"text"},"finish_reason":null}]}
 *   data: [DONE]
 */
import type { Context } from 'hono';
import type { StorageAdapter } from '@sci/core';
export declare function handleOpenAIChat(c: Context, adapter: StorageAdapter, openrouterKey: string): Promise<Response>;
//# sourceMappingURL=openai.d.ts.map