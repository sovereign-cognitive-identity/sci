/**
 * BYO credential resolution for the agent (SCI-119).
 *
 * The v0.5 agent is a personal proxy: the user already has API keys with
 * Anthropic, OpenAI, etc. and Sci's job is to anonymize + augment requests
 * en route to those providers. The user sets keys *once* with Sci instead
 * of per-tool, so any HTTPS_PROXY-respecting tool — `claude`, the Anthropic
 * SDK, `openai-python`, `curl`, raw fetch — works regardless of whether
 * the tool itself has credentials configured.
 *
 * Resolution order (highest priority first):
 *
 *   1. Process env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) —
 *      handy for development; ephemeral.
 *   2. `~/.sci/credentials.env` (KEY=VALUE per line, # comments) — the
 *      stable per-user config. 0600 perms enforced (warn if looser).
 *   3. The header the client tool sent — pass-through fallback so a tool
 *      with its own keys still works without Sci config.
 *
 * Why a tiny .env-style file instead of TOML/JSON: this is *secrets* —
 * keep the format trivial enough to inspect in `cat`. Adding a TOML
 * dependency for ~5 keys is not the right call.
 *
 * The agent runs under launchd/systemd in production (SCI-120), where
 * shell env isn't propagated. The on-disk file is the durable source.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
const FILE_NAME = 'credentials.env';
/**
 * Read the agent's credential bundle. Logs (to stderr) a one-time summary
 * of which providers are configured at startup so the user can confirm
 * Sci is seeing what they expect — without ever logging the key bytes.
 */
export function loadCredentials(configDir) {
    const fileCreds = readCredsFile(join(configDir, FILE_NAME));
    // Env vars take priority over the file. Use `nonEmpty` (not `??`) so an
    // empty `ANTHROPIC_API_KEY=` exported in a shell — common when a user is
    // toggling keys around — doesn't shadow a real value sitting in the
    // file. `??` only checks null/undefined; empty strings would silently
    // erase the file value otherwise.
    const out = {
        anthropic: nonEmpty(process.env['ANTHROPIC_API_KEY']) ?? fileCreds.anthropic,
        openai: nonEmpty(process.env['OPENAI_API_KEY']) ?? fileCreds.openai,
        openrouter: nonEmpty(process.env['OPENROUTER_API_KEY']) ?? fileCreds.openrouter,
        // Google's SDK reads either GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY
        // depending on the library version; accept either so users don't have to
        // remember which.
        google: nonEmpty(process.env['GOOGLE_GENERATIVE_AI_API_KEY'])
            ?? nonEmpty(process.env['GEMINI_API_KEY'])
            ?? fileCreds.google,
    };
    // Drop unset keys so `summarizeCredentials` can simply enumerate Object.keys.
    for (const k of Object.keys(out)) {
        if (!out[k])
            delete out[k];
    }
    return out;
}
const nonEmpty = (v) => v && v.length > 0 ? v : undefined;
/** One-line stderr summary of which provider keys are configured. */
export function summarizeCredentials(creds) {
    const present = Object.keys(creds).filter(k => creds[k]);
    if (present.length === 0)
        return 'no provider keys configured (set ANTHROPIC_API_KEY etc. or ~/.sci/credentials.env)';
    return `provider keys loaded: ${present.join(', ')}`;
}
/** Parse `KEY=VALUE` per line, with `#` comments and optional quoted values. */
function readCredsFile(path) {
    if (!existsSync(path))
        return {};
    // Soft-warn on loose perms instead of refusing — these are the user's
    // own keys on their own machine; getting in their way over chmod is
    // worse than the marginal safety benefit. Log loud enough they notice.
    try {
        const m = statSync(path).mode & 0o777;
        if (m & 0o077) {
            process.stderr.write(`[sci-agent] warning: ${path} is mode 0${m.toString(8)}; recommend 0600\n`);
        }
    }
    catch { /* ignore stat errors */ }
    const text = readFileSync(path, 'utf-8');
    const map = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq < 0)
            continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Strip matching surrounding single or double quotes if present, so
        // both `KEY=value` and `KEY="value"` work.
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        map[key] = val;
    }
    return {
        anthropic: map['ANTHROPIC_API_KEY'],
        openai: map['OPENAI_API_KEY'],
        openrouter: map['OPENROUTER_API_KEY'],
        google: map['GOOGLE_GENERATIVE_AI_API_KEY'] ?? map['GEMINI_API_KEY'],
    };
}
// ── Provider-specific header rewriting ──────────────────────────────────────
/**
 * Each provider wants its credential in a different header. Sci's job at
 * dispatch time is to make sure the buffered `IncomingMessage`'s headers
 * carry the right one — the existing handlers in `@sci/proxy/handlers`
 * read whichever convention applies to the upstream they're forwarding to.
 *
 * Mutating `req.headers` in place is the cleanest path: the
 * `makeHandlerContext` shim reads from `req.headers`, the handler reads
 * via `c.req.header(name)`, and both see the injected value without any
 * special plumbing.
 */
export function injectCredentialForHost(hostname, reqHeaders, creds) {
    const host = hostname.toLowerCase();
    if (host === 'api.anthropic.com' && creds.anthropic) {
        // Anthropic: x-api-key. Strip authorization so the handler's lookup
        // (`authorization ?? x-api-key`) lands on the freshly-injected value
        // and doesn't accidentally use a stale Bearer the tool sent.
        reqHeaders['x-api-key'] = creds.anthropic;
        delete reqHeaders['authorization'];
        return;
    }
    if (host === 'api.openai.com' && creds.openai) {
        reqHeaders['authorization'] = `Bearer ${creds.openai}`;
        return;
    }
    if (host === 'openrouter.ai' && (creds.openrouter ?? creds.openai)) {
        // OpenRouter accepts the same Bearer shape. Prefer the user's
        // OpenRouter key if they have one; fall back to OpenAI key for the
        // case where they're using OpenRouter as a drop-in.
        reqHeaders['authorization'] = `Bearer ${creds.openrouter ?? creds.openai}`;
        return;
    }
    if (host === 'generativelanguage.googleapis.com' && creds.google) {
        reqHeaders['x-goog-api-key'] = creds.google;
        return;
    }
    // No matching credential — leave headers untouched so pass-through still
    // works for tools that bring their own keys.
}
//# sourceMappingURL=credentials.js.map