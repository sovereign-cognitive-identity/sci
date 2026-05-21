import type { StorageAdapter } from './storage/interface.js';
export interface DecayResult {
    updated: number;
    flagged: number;
    summary: string;
}
export declare function calculateDecay(confidence: number, accessCount: number, lastAccessedAt: Date, now?: Date): number;
export declare function runDecayPass(adapter: StorageAdapter): Promise<DecayResult>;
//# sourceMappingURL=decay.d.ts.map