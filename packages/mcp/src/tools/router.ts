/**
 * Model router — Phase 3
 *
 * Routes each query to the best model based on task type, context length, and priority.
 * Uses OpenRouter as the unified API layer.
 *
 * Routing logic:
 *   - Long context (>32k tokens) → Claude Sonnet (200k context window)
 *   - Code generation/review → Claude Sonnet (best code quality)
 *   - Quick Q&A / factual → Gemini Flash (fast, cheap, accurate)
 *   - Reasoning / analysis → Claude Sonnet or Gemini Pro
 *   - Cost priority → Gemini Flash Lite or Claude Haiku
 *   - Speed priority → Gemini Flash Lite
 */

interface RouteResult {
  model: string
  provider: string
  reason: string
  estimated_cost_per_1k_tokens: number
  context_window: number
  api_base: string
}

const MODELS = {
  'claude-sonnet': {
    id: 'anthropic/claude-sonnet-4-5',
    provider: 'Anthropic via OpenRouter',
    cost: 0.003,
    context: 200000,
  },
  'claude-haiku': {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'Anthropic via OpenRouter',
    cost: 0.001,
    context: 200000,
  },
  'gemini-flash': {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'Google via OpenRouter',
    cost: 0.0001,
    context: 1000000,
  },
  'gemini-pro': {
    id: 'google/gemini-2.5-pro',
    provider: 'Google via OpenRouter',
    cost: 0.00125,
    context: 1000000,
  },
} as const

type ModelKey = keyof typeof MODELS

function classifyTask(query: string): string {
  const q = query.toLowerCase()

  if (/\b(code|function|implement|refactor|debug|typescript|javascript|python|sql|class|interface)\b/.test(q)) {
    return 'code'
  }
  if (/\b(analyze|compare|evaluate|tradeoff|pros and cons|recommend|strategy|architecture|design)\b/.test(q)) {
    return 'reasoning'
  }
  if (/\b(what is|who is|when did|where is|how does|define|explain|list|summarize)\b/.test(q)) {
    return 'factual'
  }
  if (/\b(write|draft|create|generate|compose|document)\b/.test(q)) {
    return 'generation'
  }

  return 'general'
}

function selectModel(
  taskType: string,
  contextTokens: number,
  priority: 'speed' | 'quality' | 'cost'
): { key: ModelKey; reason: string } {
  // Long context always needs Claude
  if (contextTokens > 100_000) {
    return { key: 'claude-sonnet', reason: 'Long context — requires 200k window' }
  }

  if (priority === 'cost') {
    return { key: 'gemini-flash', reason: 'Cost priority — Gemini Flash Lite ($0.0001/1k)' }
  }

  if (priority === 'speed') {
    return { key: 'gemini-flash', reason: 'Speed priority — Gemini Flash Lite (fastest)' }
  }

  // Quality routing by task type
  switch (taskType) {
    case 'code':
      return { key: 'claude-sonnet', reason: 'Code task — Claude Sonnet (best code quality)' }
    case 'reasoning':
      return contextTokens > 50_000
        ? { key: 'claude-sonnet', reason: 'Long reasoning task — Claude Sonnet' }
        : { key: 'gemini-pro', reason: 'Reasoning task — Gemini Pro (cost-efficient at this length)' }
    case 'factual':
      return { key: 'gemini-flash', reason: 'Factual query — Gemini Flash (fast + accurate)' }
    case 'generation':
      return { key: 'claude-sonnet', reason: 'Generation task — Claude Sonnet (best output quality)' }
    default:
      return { key: 'claude-haiku', reason: 'General query — Claude Haiku (balanced)' }
  }
}

export function routeQuery(args: {
  query: string
  context_tokens?: number
  priority?: 'speed' | 'quality' | 'cost'
}): RouteResult {
  const contextTokens = args.context_tokens ?? 1000
  const priority = args.priority ?? 'quality'
  const taskType = classifyTask(args.query)

  const { key, reason } = selectModel(taskType, contextTokens, priority)
  const model = MODELS[key]

  return {
    model: model.id,
    provider: model.provider,
    reason: `[${taskType}] ${reason}`,
    estimated_cost_per_1k_tokens: model.cost,
    context_window: model.context,
    api_base: 'https://openrouter.ai/api/v1',
  }
}
