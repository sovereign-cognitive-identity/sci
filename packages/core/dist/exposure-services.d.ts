export interface AIFeature {
    name: string;
    description: string;
    url?: string;
}
export interface ExposureService {
    id: string;
    vendor: string;
    domains: string[];
    ai_features: AIFeature[];
    processed_by: string[];
    data_categories: string[];
    user_control?: string;
    source_url?: string;
    last_verified?: string;
}
export interface ExposureCatalog {
    version: number;
    last_updated: string;
    services: ExposureService[];
}
export declare function loadExposureCatalog(): ExposureCatalog;
/**
 * Match a hostname against the catalog. Returns the matching service or
 * null. Performs exact match first, then walks up subdomain components
 * (e.g. `foo.bar.notion.so` → `bar.notion.so` → `notion.so` → match).
 */
export declare function matchHostname(hostname: string): ExposureService | null;
/** All services, for the dashboard catalog view. */
export declare function listExposureServices(): ExposureService[];
/** Look up one service by id (e.g. for an event-detail expansion). */
export declare function getExposureService(id: string): ExposureService | null;
//# sourceMappingURL=exposure-services.d.ts.map