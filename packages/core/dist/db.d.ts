export declare const reader: import("pg").Pool;
export declare const writer: import("pg").Pool;
export declare function checkConnection(): Promise<boolean>;
/** Gracefully drain both pools. Call before process.exit to avoid exit 134. */
export declare function drainPools(): Promise<void>;
//# sourceMappingURL=db.d.ts.map