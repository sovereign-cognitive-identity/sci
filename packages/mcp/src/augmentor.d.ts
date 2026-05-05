export interface MemoryInput {
    content: string;
    profileId: string;
    source?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
}
export interface WriteOperation {
    operation: 'store_episodic' | 'store_semantic' | 'update_decay';
    payload: Record<string, unknown>;
}
export declare class Augmentor {
    store(input: MemoryInput): Promise<{
        id: string;
    }>;
    storeIdentityFact(content: string, category: string, confidence?: number): Promise<{
        id: string;
    }>;
    queue(op: WriteOperation): Promise<void>;
    private _recordQueue;
}
//# sourceMappingURL=augmentor.d.ts.map