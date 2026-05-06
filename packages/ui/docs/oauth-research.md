# OAuth flow research — Claude Desktop / Claude Code

Reverse-engineered from `/Applications/Claude.app/Contents/Resources/app.asar` (extracted to `/tmp/claude-asar`, main bundle at `.vite/build/index.js`, version 1.5354.0). All findings are static — no runtime capture was needed.

## Summary

Claude Desktop uses standard **OAuth 2.0 with PKCE (S256) and a loopback redirect**. Anthropic accepts a hard-coded `client_id` with any `http://127.0.0.1:<port>/callback` redirect, which means our Sci-native UI can reuse the same `client_id` without registering its own OAuth client.

## Endpoints

| Step | URL |
|---|---|
| Authorize | `https://claude.com/cai/oauth/authorize` |
| Token | `https://platform.claude.com/v1/oauth/token` |

(There's an alternative authorize URL `https://platform.claude.com/oauth/authorize` for the console / API-key creation flow — we don't need it.)

## Client ID

```
9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

This matches the cache key we observed in `~/Library/Application Support/Claude/config.json` (the encrypted `oauth:tokenCache` entry).

## Scopes

For the desktop / Claude Code flow that grants subscription-backed inference:

```
user:inference user:profile user:sessions:claude_code
```

Other scopes that exist in the codebase but we don't need: `user:file_upload`, `user:office`, `user:mcp_servers`.

The `user:sessions:claude_code` scope is significant — when present, the token request **omits `expires_in`**, which the server treats as "long-lived session" (essentially a refresh-token-only flow). Without that scope, tokens are issued with a default `expires_in`.

## Authorization request

> **Updated after POC validation.** The static-analysis-only version of this section (no `code=true`, `127.0.0.1` redirect, 16-byte state, 3-scope set) is rejected by Anthropic's auth server with `Authorization failed — Invalid request format`. The live values below were verified end-to-end on 2026-05-06 by replicating the Claude Code CLI's `buildAuthUrl()` byte-for-byte (`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`). Full POC at [`oauth-poc.mjs`](./oauth-poc.mjs).

```
GET https://claude.com/cai/oauth/authorize
  ?code=true                           ← Anthropic-specific marker; REQUIRED
  &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
  &response_type=code
  &redirect_uri=http%3A%2F%2Flocalhost%3A<port>%2Fcallback   ← `localhost`, not `127.0.0.1`
  &scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload
  &code_challenge=<base64url(sha256(code_verifier))>
  &code_challenge_method=S256
  &state=<base64url(randomBytes(32))>
```

Param order matches the CLI verbatim. We don't know which parts of the order/format Anthropic strictly validates — keep them all in this order.

PKCE construction:
```js
const code_verifier  = randomBytes(32).toString('base64url');         // 43 chars
const code_challenge = sha256(code_verifier).digest('base64url');     // 43 chars
const state          = randomBytes(32).toString('base64url');         // 43 chars (CLI uses 32, not 16)
```

Scope set: include the full Claude-Code-CLI scope set even if we only need a subset. Anthropic appears to validate the requested scopes against the client's allowed list and rejects unknown combinations. Subset of three (`user:inference user:profile user:sessions:claude_code`) is rejected.

The user is redirected back to `http://localhost:<port>/callback?code=...&state=...`. Listen on `127.0.0.1:<port>` (Chrome routes `localhost` to IPv4 loopback) and let the redirect_uri advertise `localhost`.

## Token exchange (authorization_code)

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type":    "authorization_code",
  "client_id":     "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code":          "<auth code from callback>",
  "redirect_uri":  "http://127.0.0.1:<port>/callback",
  "state":         "<state>",
  "code_verifier": "<code_verifier>"
}
```

Response:
```json
{
  "access_token":  "<bearer>",
  "refresh_token": "<refresh>",
  "expires_in":    3600
}
```

(With `user:sessions:claude_code` in scope, `expires_in` is omitted — token effectively doesn't expire on its own; rotate via refresh.)

## Token refresh

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type":    "refresh_token",
  "client_id":     "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "refresh_token": "<refresh_token>",
  "scope":         "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

**Authorize and refresh use different scope sets.** `org:create_api_key` is a one-shot scope used during initial auth for the API-key creation flow; sending it on refresh returns `400 invalid_scope`. The refresh-eligible scope set is the 5 user scopes above (matches Claude Code CLI's `EH8` constant).

Best practice: persist the granted `scope` string from the auth-code response and echo it back on every refresh — guarantees we never request something the user didn't grant.

Response: same shape as the auth-code exchange.

## Using the token

OAuth-authenticated `/v1/messages` requests need an extra header that doesn't appear in any of Anthropic's public docs:

```
anthropic-beta: oauth-2025-04-20
```

This is the constant `cJ` in Claude Code's `cli.js`. Without it Anthropic's API will accept the OAuth Bearer at the auth layer but reject the request at the inference layer with an `invalid_api_key`-shaped error. With it, billing routes to the user's Pro/Max subscription (`service_tier: "standard"` in the response).

Verified end-to-end with a direct call to `api.anthropic.com`:

```bash
curl -sS https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
# → 200 with content array
```

Through the Sci proxy at `localhost:3001`, the same call:
- Bills against the user's Pro/Max subscription (because of the OAuth scopes), not API credits
- Goes through Sci's full anonymization + memory injection pipeline
- Streams an Anthropic-format SSE response back

The proxy's direct-mode forwarder needs to preserve the `anthropic-beta` header (it already preserves `Authorization` and `anthropic-version`).

## Implementation notes for `oauth.ts`

- `crypto.randomBytes(32).toString('base64url')` — Node 16+ supports `base64url`.
- The local HTTP server listens on `127.0.0.1` with port 0 (any free port). Using `Connection: close` in the response avoids socket reuse issues.
- Validate `state` from the callback URL matches the one we generated.
- The callback page should be a small HTML stub that says "you can close this tab" — Claude Desktop's bundle does the same.
- Token cache file at `~/.sci/oauth.json`, mode 0600. Shape: `{access_token, refresh_token, expires_at_ms?, scopes[]}`.
- On `getAccessToken()`, if `expires_at_ms` exists and is within 60s, refresh.
- On 401 from upstream during a Sci proxy call, refresh once and retry.

## Open question we accepted as a known risk

Whether Anthropic will reject tokens issued under `client_id 9d1c250a…` if our user-agent / referer doesn't match Claude Desktop's. The design above assumes it won't — there's nothing in the bundle that suggests that-level enforcement. We'll know for sure once we run a real auth-code exchange.

## Resolved during POC validation (2026-05-06)

- The `client_id 9d1c250a-e61b-44d9-88ed-5944d1962f5e` is the **Claude Code CLI** client, not the desktop login client. The desktop login client `89355bc3-cbfd-4382-905b-976645cad410` redirects to `https://claude.ai/desktop/callback` and is intercepted by Electron — not usable from a plain Node process. The CLI client supports loopback redirect, which is what we want.
- Anthropic's auth server *does* accept any `http://localhost:<port>/callback` redirect under this `client_id`. No referer / user-agent enforcement observed at either the authorize or token endpoint. Browser was Chrome (no Claude branding). Worked.
- Token response (with `user:sessions:claude_code` in scope) contains: `token_type, access_token, expires_in, refresh_token, scope, token_uuid, organization, account`. So **`expires_in` IS present** even with the long-session scope — earlier note was wrong. The `organization` and `account` fields are UUIDs we'll want to persist for per-org metadata.
