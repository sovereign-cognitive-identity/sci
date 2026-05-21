/**
 * Fake IP registry for TUN-mode interception.
 *
 * AI hostnames are assigned IPs in 198.18.0.0/15 (RFC 2544 benchmarking
 * range — not routable on the public internet). Traffic to these IPs is
 * routed to the TUN device. Our proxy's outbound connections use the REAL
 * IPs obtained via DNS, which are NOT in 198.18.0.0/15 — no routing loop.
 *
 * Registry is pre-populated at startup for known endpoints. New hostnames
 * can be assigned dynamically if needed.
 */
export declare const FAKE_IP_CIDR = "198.18.0.0/15";
/** AI hostnames we intercept. */
export declare const AI_HOSTNAMES: readonly ["api.anthropic.com", "api.openai.com", "openrouter.ai", "generativelanguage.googleapis.com"];
export type AIHostname = typeof AI_HOSTNAMES[number];
/** Assign a fake IP to a hostname (idempotent). */
export declare function assignFakeIP(hostname: string): string;
/** Reverse lookup: fake IP → hostname. Returns undefined for non-fake IPs. */
export declare function lookupByFakeIP(ip: string): string | undefined;
/** Returns the fake IP for a hostname, or undefined if not registered. */
export declare function lookupFakeIP(hostname: string): string | undefined;
/** Returns true if the hostname is a known AI endpoint. */
export declare function isAIHostname(hostname: string): boolean;
/** Returns true if the IP is in the fake IP range (198.18.0.0/15). */
export declare function isFakeIP(ip: string): boolean;
/** Pre-populate the registry for all known AI endpoints. */
export declare function warmFakeIPs(): void;
/** Returns all current mappings (for diagnostics). */
export declare function listFakeIPs(): Array<{
    hostname: string;
    ip: string;
}>;
//# sourceMappingURL=fake-ip.d.ts.map