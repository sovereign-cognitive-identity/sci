/**
 * Model router — maps client model requests to OpenRouter model IDs.
 *
 * Three modes:
 *   pass-through:  client asks for X, we use X (translated to OpenRouter ID)
 *   smart:         ignore client model, pick based on query content
 *   budget:        prefer cheap models, upgrade only when needed
 *
 * Default: pass-through with smart fallback for unknown models.
 */
const ROUTING_MODE = process.env['SCI_ROUTING_MODE'] ?? 'direct';
// Map Anthropic model names → OpenRouter IDs
const ANTHROPIC_TO_OPENROUTER = {
    'claude-opus-4-5': 'anthropic/claude-opus-4-5',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4-5',
    'claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet',
    'claude-3-5-haiku-20241022': 'anthropic/claude-3.5-haiku',
    'claude-3-opus-20240229': 'anthropic/claude-3-opus',
};
// Smart routing model choices
const SMART_MODELS = {
    code: 'anthropic/claude-sonnet-4-5',
    reasoning: 'google/gemini-2.5-pro',
    factual: 'google/gemini-2.5-flash-lite',
    generation: 'anthropic/claude-sonnet-4-5',
    default: 'anthropic/claude-haiku-4-5',
};
function classifyQuery(text) {
    const q = text.toLowerCase();
    if (/\b(code|function|implement|refactor|debug|typescript|javascript|python|sql)\b/.test(q))
        return 'code';
    if (/\b(analyze|compare|evaluate|tradeoff|strategy|architecture|design|reason)\b/.test(q))
        return 'reasoning';
    if (/\b(what is|who is|when did|where is|how does|define|explain|list)\b/.test(q))
        return 'factual';
    if (/\b(write|draft|create|generate|compose|document)\b/.test(q))
        return 'generation';
    return 'default';
}
export function selectModel(clientModel, queryText) {
    if (ROUTING_MODE === 'smart') {
        const category = classifyQuery(queryText);
        return SMART_MODELS[category];
    }
    // Pass-through: translate Anthropic model names to OpenRouter IDs
    if (clientModel in ANTHROPIC_TO_OPENROUTER) {
        return ANTHROPIC_TO_OPENROUTER[clientModel];
    }
    // Versioned Anthropic model names (e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6)
    // Pass through directly — Anthropic accepts these in direct mode
    if (clientModel.startsWith('claude-')) {
        return clientModel;
    }
    // Already an OpenRouter-style ID (e.g. "gpt-4o", "google/gemini-2.5-flash")
    if (clientModel.includes('/') || clientModel.startsWith('gpt-') || clientModel.startsWith('gemini-')) {
        return clientModel;
    }
    // Unknown model — fall back to Claude Haiku
    console.warn(`[proxy] Unknown model "${clientModel}", falling back to claude-haiku-4-5`);
    return 'anthropic/claude-haiku-4-5';
}
//# sourceMappingURL=router.js.map