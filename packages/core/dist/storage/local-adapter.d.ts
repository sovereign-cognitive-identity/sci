import type { StorageAdapter, Profile, SemanticNode, IdentityFact, RecallResult, StorageStats } from './interface.js';
export declare class LocalAdapter implements StorageAdapter {
    readonly backend = "postgres";
    private _reader;
    private _writer;
    constructor(readerUrl: string, writerUrl: string);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getProfiles(): Promise<Profile[]>;
    getProfile(name: string): Promise<Profile | null>;
    createProfile(name: string): Promise<Profile>;
    storeEpisodic(input: {
        profileId: string;
        content: string;
        embedding: number[];
        source?: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
    }): Promise<{
        id: string;
    }>;
    storeSemantic(input: {
        profileId: string;
        content: string;
        embedding: number[];
        category?: string;
        confidence?: number;
        metadata?: Record<string, unknown>;
    }): Promise<{
        id: string;
    }>;
    reinforceSemantic(id: string): Promise<void>;
    updateDecayScore(id: string, score: number, flagged: boolean): Promise<void>;
    getSemanticNodes(profileId: string, options?: {
        minConfidence?: number;
        minDecay?: number;
        limit?: number;
    }): Promise<SemanticNode[]>;
    storeIdentityFact(input: {
        content: string;
        embedding: number[];
        category?: string;
        confidence?: number;
        metadata?: Record<string, unknown>;
    }): Promise<{
        id: string;
    }>;
    recall(input: {
        queryEmbedding: number[];
        query: string;
        profileId: string;
        limit: number;
        types: Array<'episodic' | 'semantic' | 'identity'>;
    }): Promise<RecallResult[]>;
    queryIdentityFacts(options?: {
        query?: string;
        queryEmbedding?: number[];
        category?: string;
        limit?: number;
    }): Promise<IdentityFact[]>;
    getEpisodicMemoriesInWindow(options: {
        profileId: string;
        windowStart: Date;
        windowEnd: Date;
        minLength?: number;
        excludeDigests?: boolean;
        limit?: number;
    }): Promise<Array<{
        id: string;
        content: string;
    }>>;
    countEpisodicMemoriesInWindow(windowStart: Date, windowEnd: Date): Promise<number>;
    findSimilarSemanticNode(embedding: number[], profileId: string, threshold?: number): Promise<{
        id: string;
        content: string;
    } | null>;
    getSemanticNodesForGraph(profileId: string, options?: {
        minConfidence?: number;
        minDecay?: number;
        limit?: number;
    }): Promise<Array<{
        id: string;
        content: string;
    }>>;
    getLastEpisodicWrite(): Promise<Date | null>;
    insertSemanticEdge(sourceId: string, targetId: string, relationship: string, confidence: number): Promise<void>;
    getStats(): Promise<StorageStats>;
    recordWrite(operation: string, payload: Record<string, unknown>): Promise<void>;
    getLastConsolidationRun(): Promise<Date | null>;
    recordConsolidationRun(data: {
        windowStart: Date;
        windowEnd: Date;
        episodicProcessed: number;
        semanticPromoted: number;
        semanticReinforced: number;
        nodesDecayed: number;
        digestId?: string;
        modelUsed?: string;
        durationMs: number;
    }): Promise<void>;
    sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
//# sourceMappingURL=local-adapter.d.ts.map