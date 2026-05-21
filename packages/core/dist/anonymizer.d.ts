import type { Pool } from 'pg';
export type EntityType = 'PERSON' | 'PLACE' | 'ORG' | 'PROJECT' | 'EMAIL' | 'PHONE' | 'URL' | 'HANDLE';
export interface Entity {
    text: string;
    type: EntityType;
}
export interface TokenMap {
    forward: Map<string, string>;
    reverse: Map<string, string>;
}
export interface AnonymizeResult {
    text: string;
    tokenMap: TokenMap;
    entityCount: number;
    detected: Entity[];
}
/** Extract entities from pre-fetched identity fact rows (used by StorageAdapter path) */
export declare function extractEntitiesFromFacts(rows: Array<{
    content: string;
    category: string;
}>): Entity[];
export declare function loadCustomEntities(reader: Pool): Promise<Entity[]>;
/** Load custom entities via StorageAdapter (works with any backend) */
export declare function loadCustomEntitiesFromAdapter(adapter: import('./storage/interface.js').StorageAdapter): Promise<Entity[]>;
export declare function invalidateCustomEntityCache(): void;
export declare function buildTokenMap(entities: Entity[], existing?: TokenMap): TokenMap;
/**
 * Synchronous anonymize — uses only regex + NLP (no DB).
 * Use anonymizeAsync for full coverage including custom entities.
 */
export declare function anonymize(text: string, existing?: TokenMap): AnonymizeResult;
/**
 * Full anonymize with DB-loaded custom entities (project names, known orgs etc.)
 *
 * sessionEntities — entities seen in previous calls this session (item 1: feedback loop).
 * These are checked proactively even if NER/CamelCase wouldn't catch them this turn.
 */
export declare function anonymizeAsync(text: string, readerOrAdapter: Pool | import('./storage/interface.js').StorageAdapter, existing?: TokenMap, sessionEntities?: Entity[]): Promise<AnonymizeResult>;
export declare function deanonymize(text: string, tokenMap: TokenMap): string;
export declare function createSession(): string;
export declare function getSession(id: string): TokenMap | undefined;
export declare function anonymizeWithSession(text: string, sessionId: string): AnonymizeResult;
export declare function anonymizeWithSessionAsync(text: string, sessionId: string, reader: Pool | import('./storage/interface.js').StorageAdapter): Promise<AnonymizeResult>;
export declare function deanonymizeWithSession(text: string, sessionId: string): string;
export declare function discardSession(sessionId: string): void;
/** Returns entities ready for promotion to identity_facts, then clears the queue */
export declare function drainPendingPromotions(): Array<{
    text: string;
    type: EntityType;
}>;
export declare function describeTokenMap(tokenMap: TokenMap): string;
//# sourceMappingURL=anonymizer.d.ts.map