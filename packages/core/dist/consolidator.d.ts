import type { StorageAdapter } from './storage/interface.js';
export interface PromotionResult {
    promoted: number;
    reinforced: number;
    batches: number;
}
export declare function runPromotionPass(windowStart: Date, windowEnd: Date, profileId: string, apiKey: string, model: string, adapter: StorageAdapter): Promise<PromotionResult>;
export interface GraphResult {
    edges_created: number;
}
export declare function runGraphPass(profileId: string, apiKey: string, model: string, adapter: StorageAdapter): Promise<GraphResult>;
//# sourceMappingURL=consolidator.d.ts.map