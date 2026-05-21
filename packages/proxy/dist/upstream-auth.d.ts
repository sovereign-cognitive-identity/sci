/**
 * Returns a usable Anthropic access token, refreshing if needed. Returns null
 * if no cache exists at all (caller should error out — user must run
 * `docker compose --profile setup run --rm --service-ports sci-auth`).
 */
export declare function getAnthropicAccessToken(): Promise<string | null>;
//# sourceMappingURL=upstream-auth.d.ts.map