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
export declare function selectModel(clientModel: string, queryText: string): string;
//# sourceMappingURL=router.d.ts.map