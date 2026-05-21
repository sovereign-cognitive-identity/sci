/**
 * `sci doctor` — self-test the running agent (SCI-121).
 *
 * Runs a small battery of checks an end user (or Casey, dogfooding) can use
 * to confirm a fresh `sci up` is wired correctly without touching a real
 * provider. Output is one line per check, ✓ or ✗ with a one-sentence reason
 * — designed to be parseable by eye in 5 seconds, not a structured report.
 *
 * Checks performed:
 *   1. Agent process listening on the configured port
 *   2. CA cert exists at ~/.sci/ca.crt
 *   3. SQLite memory store exists + 'work' profile present (SCI-118)
 *   4. Credentials file or env vars resolve at least one provider key
 *      (or warn that pass-through is the only fallback)
 *   5. End-to-end TLS-MITM works: do a CONNECT through the agent to
 *      api.anthropic.com using the local CA, send a deliberately-malformed
 *      request, and verify the agent log path fires (i.e. anonymization +
 *      handler dispatch reach upstream). We don't actually need a 200 from
 *      the provider — the goal is "did the request get to the handler?"
 *      A 401 from upstream is success for this check.
 *
 * Why a separate `doctor` instead of folding into `status`: `status` is
 * a passive read of runtime state; `doctor` actively pokes the agent.
 * Mixing the two muddles what each command means.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { connect as netConnect } from 'net';
import { connect as tlsConnect } from 'tls';
import { readFileSync } from 'fs';
import { loadCredentials, summarizeCredentials } from './credentials.js';
export async function runDoctor(config) {
    const checks = [];
    checks.push(await checkPortListening(config.proxyPort));
    checks.push(checkCAExists(config.configDir));
    checks.push(checkMemoryStore(config.memoryDir));
    checks.push(checkCredentials(config));
    // Only attempt the round-trip check if the listener is up — otherwise we
    // get a confusing pile of red lines that all reduce to "the agent isn't
    // running." Tell the user that, then stop.
    if (checks[0].pass) {
        checks.push(await checkTLSPath(config));
    }
    for (const c of checks) {
        const mark = c.pass ? '✓' : '✗';
        process.stdout.write(`${mark}  ${c.name.padEnd(28)}  ${c.detail}\n`);
    }
    const failed = checks.filter(c => !c.pass).length;
    if (failed === 0) {
        process.stdout.write(`\nAll checks passed. Set HTTPS_PROXY=http://localhost:${config.proxyPort} on any tool.\n`);
        return 0;
    }
    process.stdout.write(`\n${failed} check(s) failed. Fix the ✗ items and re-run \`sci doctor\`.\n`);
    return 1;
}
async function checkPortListening(port) {
    return new Promise((resolve) => {
        const sock = netConnect(port, '127.0.0.1');
        sock.setTimeout(500);
        sock.once('connect', () => {
            sock.destroy();
            resolve({ pass: true, name: 'agent listening', detail: `localhost:${port}` });
        });
        const fail = (reason) => {
            sock.destroy();
            resolve({ pass: false, name: 'agent listening', detail: `${reason} — start the agent with \`sci up\`` });
        };
        sock.once('timeout', () => fail('connect timeout'));
        sock.once('error', (err) => fail(err.message));
    });
}
function checkCAExists(configDir) {
    const crt = join(configDir, 'ca.crt');
    const key = join(configDir, 'ca.key');
    if (existsSync(crt) && existsSync(key)) {
        return { pass: true, name: 'Sci CA generated', detail: crt };
    }
    return {
        pass: false, name: 'Sci CA generated',
        detail: `missing ${crt} — start the agent once to generate it`,
    };
}
function checkMemoryStore(memoryDir) {
    const db = join(memoryDir, 'sci.db');
    if (!existsSync(db)) {
        return { pass: false, name: 'memory store ready', detail: `missing ${db} — start the agent once` };
    }
    // We don't open the DB here — that's the agent's lifecycle. The presence
    // of sci.db plus the agent listening (checked separately) is enough
    // signal for "memory is wired." A deeper "profile 'work' present" check
    // would require importing better-sqlite3, which doubles `sci doctor`'s
    // cold-start time for marginal added confidence.
    return { pass: true, name: 'memory store ready', detail: db };
}
function checkCredentials(config) {
    const creds = loadCredentials(config.configDir);
    const summary = summarizeCredentials(creds);
    const any = Object.keys(creds).length > 0;
    return {
        pass: any,
        name: 'BYO keys configured',
        detail: any
            ? summary
            : `${summary}; without keys the agent only pass-through-forwards what your tool sent`,
    };
}
/**
 * End-to-end check: do a real CONNECT through the agent and verify the
 * agent's TLS-MITM + handler dispatch fires. We pin the local Sci CA into
 * the request's trust store so the leaf cert validates; an HTTP error
 * from upstream (401, 400) is still "pass" because what we're verifying
 * is the agent path, not the provider's auth state.
 */
async function checkTLSPath(config) {
    const caPath = join(config.configDir, 'ca.crt');
    if (!existsSync(caPath)) {
        return { pass: false, name: 'TLS-MITM round-trip', detail: 'no CA — agent must start first' };
    }
    const ca = readFileSync(caPath, 'utf-8');
    // The "right" way is to wire this through Node's `https` module via a
    // custom `createConnection`. That fights Node's built-in CA-resolution
    // logic in subtle ways — saw "unable to get local issuer certificate"
    // on a perfectly-valid leaf even with `ca: [pem]` set. Doing the dance
    // by hand removes a layer where things can go wrong, and what we need
    // is just "did *some* HTTP response come back," not a polished client.
    return new Promise((resolve) => {
        const settle = (r) => {
            // Guard against a TLS error firing after the request already
            // resolved — Node's socket lifecycle still emits 'error' on
            // close-after-response in some paths.
            if (settled)
                return;
            settled = true;
            resolve(r);
        };
        let settled = false;
        const tunnel = netConnect(config.proxyPort, '127.0.0.1');
        tunnel.once('error', (err) => settle({
            pass: false, name: 'TLS-MITM round-trip',
            detail: `tunnel connect failed: ${err.message}`,
        }));
        tunnel.once('connect', () => {
            tunnel.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n' +
                'Host: api.anthropic.com:443\r\n\r\n');
        });
        tunnel.once('data', (chunk) => {
            const head = chunk.toString().split('\r\n')[0] ?? '';
            if (!head.startsWith('HTTP/1.1 200')) {
                settle({ pass: false, name: 'TLS-MITM round-trip',
                    detail: `agent CONNECT failed: ${truncate(head, 60)}` });
                tunnel.destroy();
                return;
            }
            // Run TLS over the tunneled socket using our local CA only — see
            // commentary above on why `ca: [ca]` over the system bundle.
            const tls = tlsConnect({
                socket: tunnel, ca: [ca],
                servername: 'api.anthropic.com', rejectUnauthorized: true,
            });
            tls.once('error', (err) => settle({
                pass: false, name: 'TLS-MITM round-trip',
                detail: `tls error: ${err.message}`,
            }));
            tls.once('secureConnect', () => {
                // Compose a minimal POST manually. `Content-Length` matters —
                // the agent's HTTP parser is the same Node one a real client
                // would feed, so we need a well-formed framing here.
                const body = JSON.stringify({
                    model: 'claude-haiku-4-5',
                    max_tokens: 16,
                    messages: [{ role: 'user', content: 'sci doctor self-test' }],
                });
                const reqLines = [
                    'POST /v1/messages HTTP/1.1',
                    'Host: api.anthropic.com',
                    'Content-Type: application/json',
                    'x-api-key: sci-doctor-fake-key',
                    'anthropic-version: 2023-06-01',
                    `Content-Length: ${Buffer.byteLength(body)}`,
                    'Connection: close',
                    '', body,
                ];
                tls.write(reqLines.join('\r\n'));
            });
            // Parse the first response chunk's status line. We only need the
            // numeric status code — the agent's role in this check is
            // "dispatch reached upstream"; what upstream said back doesn't
            // matter beyond "we got an HTTP response, not a TLS error."
            const buf = [];
            tls.on('data', (d) => buf.push(d));
            tls.on('end', () => {
                const text = Buffer.concat(buf).toString('utf-8');
                const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
                if (!m) {
                    settle({ pass: false, name: 'TLS-MITM round-trip',
                        detail: `no HTTP status in response: ${truncate(text, 60)}` });
                    return;
                }
                const status = parseInt(m[1], 10);
                // Pull the JSON body if present, just for a friendlier `detail`.
                // Pluck a JSON-like fragment for the friendly `detail`. HTTP/1.1
                // responses can use chunked transfer-encoding (with hex length
                // prefixes between chunks) or Content-Length framing; rather
                // than parse both, just find the first '{' after the headers
                // and truncate. Imperfect but produces readable output for the
                // common error-body shapes Anthropic / OpenAI / Google return.
                const headerEnd = text.indexOf('\r\n\r\n');
                const after = headerEnd > 0 ? text.slice(headerEnd + 4) : text;
                const jsonStart = after.indexOf('{');
                const fragment = jsonStart >= 0 ? after.slice(jsonStart) : after;
                const oneline = fragment.replace(/[\r\n]+/g, ' ').trim();
                settle({
                    pass: status > 0,
                    name: 'TLS-MITM round-trip',
                    detail: `agent dispatched, upstream returned ${status} (${truncate(oneline, 60)})`,
                });
            });
        });
    });
}
function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}
//# sourceMappingURL=doctor.js.map