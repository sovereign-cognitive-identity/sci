export declare function lookupHostnameByRealIP(ip: string): string | undefined;
/** Returns all known real IPs (for routing them through the TUN). */
export declare function listKnownRealIPs(): Array<{
    ip: string;
    hostname: string;
}>;
export declare function resolveRealDirect(hostname: string): Promise<string>;
/**
 * Pre-resolve all known AI hostnames so the real-IP-to-hostname map is
 * populated at startup. Returns the resolved real IPs for routing.
 */
export declare function warmRealIPCache(hostnames: readonly string[]): Promise<Array<{
    hostname: string;
    ip: string;
}>>;
export declare const AI_ENDPOINTS: Record<string, string>;
/** Resolve a hostname to its real IP, bypassing /etc/hosts. */
export declare function resolveReal(hostname: string): Promise<string>;
/** Pre-resolve all AI endpoints and warm the cache. Called at proxy startup. */
export declare function warmDNSCache(): Promise<void>;
//# sourceMappingURL=dns-resolver.d.ts.map