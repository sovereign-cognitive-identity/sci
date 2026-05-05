declare const MODEL_ID: string;
declare const DIMENSIONS = 768;
export declare function embed(text: string): Promise<number[]>;
export declare function embedBatch(texts: string[]): Promise<number[][]>;
export { MODEL_ID, DIMENSIONS };
//# sourceMappingURL=embeddings.d.ts.map