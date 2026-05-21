export interface MemoryInput {
    content: string;
    profileId: string;
    source?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
}
export interface SemanticNodeInput {
    content: string;
    profileId: string;
    category?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
}
export declare class Augmentor {
    store(input: MemoryInput): Promise<{
        id: string;
    }>;
    storeSemanticNode(input: SemanticNodeInput): Promise<{
        id: string;
    }>;
    storeIdentityFact(content: string, category: string, confidence?: number): Promise<{
        id: string;
    }>;
}
//# sourceMappingURL=augmentor.d.ts.map