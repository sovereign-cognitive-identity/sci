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
import { anonymize } from '@sci/core';
import { DeanonymizingStreamV2 } from '../stream/deanonymizer.js';
import { streamFromOpenRouter } from '../openrouter.js';
import { streamDirectAnthropic } from '../direct-anthropic.js';
import { injectMemoryContext, storeInteraction } from '../middleware/memory.js';
import { selectModel } from '../router.js';
import { getTracer, SpanStatusCode } from '@sci/telemetry';
const ROUTING_MODE = process.env['SCI_ROUTING_MODE'] ?? 'direct';
function extractText(content) {
    if (typeof content === 'string')
        return content;
    return content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('');
}
/**
 * Anonymize a user message's content without destroying structured blocks.
 *
 * When content is a plain string, behaves identically to calling anonymize()
 * directly. When content is an array (tool_result, image, text blocks, etc.),
 * only the text blocks are anonymized — all other block types are preserved
 * verbatim. This prevents stripping tool_result blocks out of conversation
 * history, which would cause Anthropic's API to reject the request with
 * "tool_use ids were found without tool_result blocks" (same class of error
 * as the SCI-200 orphan repair on the Rust side).
 *
 * Returns the (possibly mutated) content plus the AnonymizeResult from the
 * text portions and the updated tokenMap for threading to the next message.
 */
function anonymizeContent(content, tokenMap) {
    if (typeof content === 'string') {
        const result = anonymize(content, tokenMap);
        return { content: result.text, extractedText: content, maskedText: result.text, result, tokenMap: result.tokenMap };
    }
    const rawParts = [];
    const maskedParts = [];
    const allDetected = [];
    let currentMap = tokenMap;
    const anonymizedBlocks = content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string' || !block.text)
            return block; // preserve non-text blocks
        rawParts.push(block.text);
        const r = anonymize(block.text, currentMap);
        currentMap = r.tokenMap;
        maskedParts.push(r.text);
        allDetected.push(...r.detected);
        return { ...block, text: r.text };
    });
    const combinedResult = {
        text: maskedParts.join(''),
        tokenMap: currentMap,
        entityCount: allDetected.length,
        detected: allDetected,
    };
    return {
        content: anonymizedBlocks,
        extractedText: rawParts.join(''),
        maskedText: maskedParts.join(''),
        result: combinedResult,
        tokenMap: currentMap,
    };
}
const ANTHROPIC_SERVER_TOOL_PREFIX = 'srvtoolu_';
/**
 * Repairs orphaned server tool use blocks in Anthropic conversation history.
 *
 * When LibreChat replays a conversation that included Anthropic's native web_search,
 * it emits an assistant message with a `server_tool_use` block (id: srvtoolu_xxx) but
 * no corresponding `web_search_tool_result` block. Anthropic rejects this with a 400.
 *
 * Root cause: @librechat/agents skips web_search_tool_result chunks when building
 * LibreChat's stored content parts (handleServerToolResult returns skipHandling=true),
 * so the result block is never persisted and cannot be included on replay.
 *
 * Fix: for every assistant message that has a server_tool_use / tool_use with a
 * srvtoolu_ id but no matching web_search_tool_result, inject a
 * web_search_tool_result_error block immediately after the orphaned tool_use.
 * This satisfies Anthropic's pairing requirement so the conversation can continue.
 *
 * Also strips any stale `tool_result` blocks in subsequent user messages whose
 * tool_use_id matches a srvtoolu_ id — LangChain produces these when formatting
 * ToolMessages without the provider=anthropic hint, and they would otherwise
 * appear as orphaned tool_results on Anthropic's side.
 */
function repairServerToolUseBlocks(messages) {
    const result = [];
    const repairedSrvIds = new Set();
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Only assistant messages need server-tool-use repair
        if (msg.role !== 'assistant' || typeof msg.content === 'string') {
            result.push(msg);
            continue;
        }
        const content = msg.content;
        // Collect srvtoolu_ tool_use ids and existing web_search_tool_result ids
        const serverToolUseIds = [];
        const existingResultIds = new Set();
        for (const block of content) {
            if ((block.type === 'server_tool_use' || block.type === 'tool_use') &&
                typeof block.id === 'string' &&
                block.id.startsWith(ANTHROPIC_SERVER_TOOL_PREFIX)) {
                serverToolUseIds.push(block.id);
            }
            if (block.type === 'web_search_tool_result' &&
                typeof block.tool_use_id === 'string') {
                existingResultIds.add(block.tool_use_id);
            }
        }
        const orphanedIds = serverToolUseIds.filter(id => !existingResultIds.has(id));
        if (orphanedIds.length === 0) {
            result.push(msg);
            continue;
        }
        // Build a new content array inserting error blocks after each orphaned tool_use
        const orphanedSet = new Set(orphanedIds);
        const newContent = [];
        for (const block of content) {
            newContent.push(block);
            if ((block.type === 'server_tool_use' || block.type === 'tool_use') &&
                typeof block.id === 'string' &&
                orphanedSet.has(block.id)) {
                newContent.push({
                    type: 'web_search_tool_result',
                    tool_use_id: block.id,
                    content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
                });
                repairedSrvIds.add(block.id);
            }
        }
        result.push({ ...msg, content: newContent });
    }
    // Strip stale tool_result blocks in user messages whose tool_use_id was repaired.
    // LangChain emits these when it doesn't know the provider is Anthropic.
    if (repairedSrvIds.size === 0)
        return result;
    return result.map(msg => {
        if (msg.role !== 'user' || typeof msg.content === 'string')
            return msg;
        const content = msg.content;
        const filtered = content.filter(block => !(block.type === 'tool_result' &&
            typeof block.tool_use_id === 'string' &&
            repairedSrvIds.has(block.tool_use_id)));
        if (filtered.length === content.length)
            return msg;
        // Keep the message even if empty — Anthropic needs strict user/assistant alternation.
        // An empty user message is better than breaking the role sequence.
        return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '' }] };
    });
}
function toOpenRouterMessages(messages, system) {
    const result = [];
    if (system)
        result.push({ role: 'system', content: system });
    for (const m of messages) {
        result.push({ role: m.role, content: extractText(m.content) });
    }
    return result;
}
function sseEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
export async function handleAnthropicMessages(c, adapter, openrouterKey) {
    const tracer = getTracer('sci-proxy');
    const body = await c.req.json();
    const streaming = body.stream !== false;
    // Extract the last user message for anonymization + memory
    const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
    const originalUserText = lastUserMsg ? extractText(lastUserMsg.content) : '';
    const reqId = `req_${Date.now().toString(36)}`;
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] ${reqId} ── incoming (${body.model}, ${body.messages.length} msgs)\n`);
    const span = tracer.startSpan('sci.llm.request', {
        attributes: {
            'llm.model': body.model,
            'llm.routing_mode': ROUTING_MODE,
            'llm.message_count': body.messages.length,
            'sci.req_id': reqId,
        },
    });
    const endSpan = (status, err) => {
        if (status === 'error' && err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
            span.recordException(err);
        }
        else {
            span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
    };
    // 1. Anonymize all user messages
    let sessionTokenMap = { forward: new Map(), reverse: new Map() };
    // Capture the anonymization result for the LATEST user turn — this is what
    // the privacy inspector renders. Earlier user turns in conversation history
    // were already masked in their own prior requests; we only need to surface
    // what's new this turn.
    let lastUserResult = null;
    let lastUserOriginal = '';
    let lastUserMaskedText = '';
    const lastUserIdx = body.messages.map(m => m.role).lastIndexOf('user');
    const anonymizedMessages = body.messages.map((m, idx) => {
        if (m.role !== 'user')
            return m;
        const { content: anonContent, extractedText, maskedText, result, tokenMap: nextMap } = anonymizeContent(m.content, sessionTokenMap);
        sessionTokenMap = nextMap;
        if (idx === lastUserIdx) {
            lastUserResult = result;
            lastUserOriginal = extractedText;
            lastUserMaskedText = maskedText;
        }
        return { ...m, content: anonContent };
    });
    // Log what got masked
    if (sessionTokenMap.forward.size > 0) {
        const masked = [...sessionTokenMap.forward.entries()].map(([e, t]) => `${t}←"${e.slice(0, 30)}"`).join('  ');
        process.stderr.write(`[${reqId}] 🔒 masked ${sessionTokenMap.forward.size}: ${masked}\n`);
    }
    else {
        process.stderr.write(`[${reqId}] ✓  no entities detected\n`);
    }
    // 2. Inject memory context into anonymized messages.
    //
    // We pass the live `sessionTokenMap` so injectMemoryContext anonymizes
    // each recalled memory using the SAME masking the user message got —
    // otherwise memory would leak real names through the system prompt.
    // The map is mutated in place (any new entities discovered in memories
    // are added), and the deanonymizer below uses the same reference to
    // swap tokens back in the response.
    const anonymizedWithContext = toOpenRouterMessages(anonymizedMessages, body.system);
    const { messages: withContext, inspector: memoryInspector } = await injectMemoryContext(anonymizedWithContext, adapter, sessionTokenMap);
    if (memoryInspector?.injected) {
        process.stderr.write(`[${reqId}] 🧠 injected ${memoryInspector.results.length} memory context items (~${memoryInspector.approxTokensAdded} tokens)\n`);
    }
    else if (memoryInspector && memoryInspector.results.length === 0) {
        process.stderr.write(`[${reqId}] 🧠 no relevant memories found\n`);
    }
    // 3. Select model (used for OpenRouter mode; direct mode uses original)
    const model = selectModel(body.model, originalUserText);
    process.stderr.write(`[${reqId}] → ${ROUTING_MODE === 'direct' ? 'api.anthropic.com' : 'openrouter.ai'} (${body.model})\n`);
    // ── Build Sci transparency events ────────────────────────────────────────
    //
    // These ride the SSE stream so the UI can render an inspector panel
    // showing the user exactly what was masked / unmasked. Anthropic-format
    // clients ignore unknown event names; only Sci-aware UIs render them.
    // Build the sci.anonymized prelude. We pass the result in as a parameter
    // so TS doesn't lose its type via flow analysis through the `.map()` closure
    // assignment above (an open issue with let + closures).
    const buildAnonPrelude = (r) => {
        if (!r || r.entityCount === 0) {
            return `event: sci.anonymized\ndata: ${JSON.stringify({
                reqId,
                original: lastUserOriginal,
                masked: lastUserMaskedText,
                entities: [],
                sessionEntityCount: sessionTokenMap.forward.size,
            })}\n\n`;
        }
        const entities = r.detected.map((e) => ({
            original: e.text,
            type: e.type,
            token: sessionTokenMap.forward.get(e.text) ?? sessionTokenMap.forward.get(e.text.toLowerCase()) ?? null,
        }));
        return `event: sci.anonymized\ndata: ${JSON.stringify({
            reqId,
            original: lastUserOriginal,
            masked: lastUserMaskedText,
            entities,
            sessionEntityCount: sessionTokenMap.forward.size,
        })}\n\n`;
    };
    const sciAnonymizedPrelude = buildAnonPrelude(lastUserResult);
    // sci.memory — what was recalled + injected for this turn. Always emitted
    // when the recall actually ran (even if 0 results), so the user can tell
    // the difference between "Sci asked memory" and "Sci skipped memory because
    // the message was too short".
    const sciMemoryPrelude = memoryInspector
        ? `event: sci.memory\ndata: ${JSON.stringify({ reqId, ...memoryInspector })}\n\n`
        : '';
    const fullPrelude = sciAnonymizedPrelude + sciMemoryPrelude;
    // ── Direct mode: forward to Anthropic with original auth ─────────────────
    if (ROUTING_MODE === 'direct') {
        // Rebuild anonymized Anthropic-format request body
        const repairedMessages = repairServerToolUseBlocks(anonymizedMessages);
        const anonymizedBody = {
            ...body,
            messages: repairedMessages,
            system: withContext.find(m => m.role === 'system')?.content ?? body.system,
            stream: true,
        };
        // Extract original auth headers to forward to Anthropic.
        //
        // `anthropic-beta` matters for OAuth-authenticated requests: Sci-native UI
        // sends `anthropic-beta: oauth-2025-04-20` so Anthropic accepts the OAuth
        // Bearer at the inference layer. Stripping it would cause Anthropic to
        // treat the request as a missing-API-key error. We forward whatever the
        // client sent (could also be e.g. `prompt-caching-2024-07-31`).
        const authHeader = c.req.header('authorization') ?? c.req.header('x-api-key');
        const betaHeader = c.req.header('anthropic-beta');
        const originalHeaders = {
            'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
            ...(betaHeader ? { 'anthropic-beta': betaHeader } : {}),
            ...(authHeader?.startsWith('Bearer ')
                ? { 'authorization': authHeader }
                : { 'x-api-key': authHeader ?? '' }),
        };
        const deanonStream = new DeanonymizingStreamV2(sessionTokenMap);
        // Preserve the original request URL including query params (e.g. ?beta=true)
        // so Anthropic returns the expected response format for extended features.
        const forwardPath = c.req.raw.url ?? '/v1/messages';
        const readable = await streamDirectAnthropic(forwardPath, anonymizedBody, originalHeaders, (text) => deanonStream.push(text), () => deanonStream.end(), () => {
            const ms = Date.now() - t0;
            process.stderr.write(`[${reqId}] ✓  complete in ${ms}ms, storing to memory\n`);
            storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => { });
        }, {
            // anonymized + memory events combined (sci.anonymized fires first,
            // sci.memory second — same single chunk before message_start).
            prelude: fullPrelude,
            // Postlude — fired after deanon drains. Reports how many tokens
            // Anthropic's response contained that we had to swap back.
            postlude: () => `event: sci.deanonymized\ndata: ${JSON.stringify({
                reqId,
                tokensReplaced: deanonStream.replacementCount,
                replaced: deanonStream.replacedTokens,
            })}\n\n`,
        });
        endSpan('ok');
        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Sci-Mode': 'direct',
                'X-Sci-Model': body.model,
            },
        });
    }
    // ── OpenRouter mode: translate and route ─────────────────────────────────
    const openRouterMessages = withContext;
    if (!streaming) {
        const chunks = [];
        for await (const delta of streamFromOpenRouter({ model, messages: openRouterMessages, max_tokens: body.max_tokens, stream: true }, openrouterKey))
            chunks.push(delta);
        const deanonStream = new DeanonymizingStreamV2(sessionTokenMap);
        deanonStream.push(chunks.join(''));
        const response = deanonStream.end();
        storeInteraction(originalUserText, response, adapter).catch(() => { });
        endSpan('ok');
        return c.json({
            id: `msg_${Date.now()}`,
            type: 'message', role: 'assistant',
            content: [{ type: 'text', text: response }],
            model, stop_reason: 'end_turn',
        });
    }
    // OpenRouter streaming
    const deanonStream = new DeanonymizingStreamV2(sessionTokenMap);
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
        async start(controller) {
            const msgId = `msg_${Date.now()}`;
            controller.enqueue(encoder.encode(sseEvent('message_start', {
                type: 'message_start',
                message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null },
            })));
            controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
            })));
            try {
                for await (const delta of streamFromOpenRouter({ model, messages: openRouterMessages, max_tokens: body.max_tokens, stream: true }, openrouterKey)) {
                    const safe = deanonStream.push(delta);
                    if (safe)
                        controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                            type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: safe },
                        })));
                }
                const final = deanonStream.end();
                if (final)
                    controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: final },
                    })));
            }
            catch (err) {
                controller.enqueue(encoder.encode(sseEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } })));
            }
            controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })));
            controller.enqueue(encoder.encode(sseEvent('message_delta', {
                type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 },
            })));
            // message_stop
            controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
            controller.close();
            // Store interaction after stream completes — fire and forget
            storeInteraction(originalUserText, deanonStream.fullResponse, adapter).catch(() => { });
        },
    });
    endSpan('ok');
    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Sci-Model': model,
        },
    });
}
//# sourceMappingURL=anthropic.js.map