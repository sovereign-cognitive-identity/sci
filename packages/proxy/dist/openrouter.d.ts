/**
 * OpenRouter client — streams responses back as an async generator of text deltas.
 *
 * All models (Claude, GPT-4, Gemini, etc.) are accessed via OpenRouter's
 * OpenAI-compatible API. The proxy translates Anthropic/OpenAI client formats
 * to OpenAI format here, and translates responses back in the handlers.
 */
export interface OpenRouterMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface OpenRouterRequest {
    model: string;
    messages: OpenRouterMessage[];
    max_tokens?: number;
    temperature?: number;
    stream: true;
}
export declare function streamFromOpenRouter(req: OpenRouterRequest, apiKey: string): AsyncGenerator<string>;
//# sourceMappingURL=openrouter.d.ts.map