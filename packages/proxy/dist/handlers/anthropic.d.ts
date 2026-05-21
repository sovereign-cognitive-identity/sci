/**
 * Anthropic Messages API handler — POST /v1/messages
 *
 * Receives requests in Anthropic format (what Claude Code sends),
 * anonymizes, injects memory context, routes through OpenRouter,
 * streams back deanonymized responses in Anthropic SSE format.
 *
 * Anthropic request format:
 *   { model, messages: [{role, content}], system?, max_tokens, stream }
 *
 * Anthropic SSE format:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 */
import type { Context } from 'hono';
import type { StorageAdapter } from '@sci/core';
export declare function handleAnthropicMessages(c: Context, adapter: StorageAdapter, openrouterKey: string): Promise<Response>;
//# sourceMappingURL=anthropic.d.ts.map