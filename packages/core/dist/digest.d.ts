import type { StorageAdapter } from './storage/interface.js';
interface DigestStats {
    episodic_new: number;
    semantic_promoted: number;
    semantic_reinforced: number;
    nodes_decayed: number;
}
export interface DigestResult {
    memory_id: string | null;
    markdown: string;
    exported_to: string | null;
}
export declare function runDigestPass(windowStart: Date, windowEnd: Date, profileId: string, stats: DigestStats, apiKey: string, model: string, adapter: StorageAdapter): Promise<DigestResult>;
export {};
//# sourceMappingURL=digest.d.ts.map