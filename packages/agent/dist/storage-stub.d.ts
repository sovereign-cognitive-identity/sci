/**
 * Stub StorageAdapter for the agent — no-op everything.
 *
 * The provider handlers in `@sci/proxy/handlers` accept any
 * `StorageAdapter` and use it for memory recall + storage. Until
 * SCI-118 lands a real SQLite adapter for the agent, we provide a stub
 * that:
 *
 *   - Returns `null` from `getProfile('work')`, so `injectMemoryContext`
 *     short-circuits (no memory injected) and the request flows through
 *     anonymized but without recall.
 *   - No-ops `recordWrite` etc., so `storeInteraction` doesn't error.
 *   - Returns empty arrays from queries that the request path doesn't
 *     reach today, so the type contract is satisfied without surprises.
 *
 * This keeps SCI-117's scope to "anonymization works in the agent"
 * without dragging in the SQLite dependency that SCI-118 owns.
 */
import type { StorageAdapter, StorageStats } from '@sci/core';
export declare class NoopStorageAdapter implements StorageAdapter {
    readonly backend = "noop";
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getProfiles(): Promise<never[]>;
    getProfile(_name: string): Promise<null>;
    createProfile(_name: string): Promise<never>;
    storeEpisodic(_input: unknown): Promise<{
        id: string;
    }>;
    storeSemantic(_input: unknown): Promise<{
        id: string;
    }>;
    reinforceSemantic(_id: string): Promise<void>;
    updateDecayScore(_id: string, _s: number, _f: boolean): Promise<void>;
    getSemanticNodes(_profileId: string, _opts?: unknown): Promise<never[]>;
    storeIdentityFact(_input: unknown): Promise<{
        id: string;
    }>;
    recall(_input: unknown): Promise<never[]>;
    queryIdentityFacts(_opts?: unknown): Promise<never[]>;
    getEpisodicMemoriesInWindow(_opts: unknown): Promise<never[]>;
    countEpisodicMemoriesInWindow(_a: Date, _b: Date): Promise<number>;
    findSimilarSemanticNode(_embedding: number[], _profileId: string, _threshold: number): Promise<null>;
    getSemanticNodesForGraph(_profileId: string, _opts?: unknown): Promise<never[]>;
    getLastEpisodicWrite(): Promise<null>;
    insertSemanticEdge(_src: string, _tgt: string, _rel: string, _conf: number): Promise<void>;
    getStats(): Promise<StorageStats>;
    recordWrite(_op: string, _payload: Record<string, unknown>): Promise<void>;
    getLastConsolidationRun(): Promise<null>;
    recordConsolidationRun(_data: unknown): Promise<void>;
    sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
