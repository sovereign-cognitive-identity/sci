/**
 * HTTPS_PROXY server — handles `CONNECT` from any tool with
 * `HTTPS_PROXY=http://localhost:8080` set.
 *
 * Two paths after CONNECT:
 *
 *   1. AI host (api.anthropic.com / api.openai.com / etc.) — terminate
 *      TLS locally with a Sci-CA-signed leaf cert (via SNI), parse the
 *      decrypted HTTP request, forward to the real upstream, stream the
 *      response back through the same TLS-terminated client socket.
 *
 *      Today (SCI-116) this path is **passthrough-with-MITM**: we
 *      intercept and re-forward verbatim with no anonymization. Wiring
 *      anonymization + memory + provider-specific handling lands in
 *      SCI-117 (handler refactor) + SCI-118 (local SQLite memory).
 *
 *      The MITM mechanic is what unlocks anonymization later. Without
 *      TLS termination at this layer, we'd never see decrypted prompt
 *      content to anonymize.
 *
 *   2. Anything else — pure socket-level tunnel. No TLS interception,
 *      no CA exposure. `socket.pipe()` the bidirectional bytes between
 *      the client and the upstream. Apps that share their HTTPS_PROXY
 *      env var with us don't break for non-AI traffic.
 */
import { type Server } from 'http';
import type { AgentConfig } from './config.js';
export declare function startProxyServer(config: AgentConfig): Promise<Server>;
/**
 * Drain the local memory adapter cleanly. Called from the agent's SIGINT
 * shutdown path so the SQLite WAL flushes and the hnswlib index is written
 * out to disk before the process exits — otherwise the most recent embeddings
 * from the in-memory index don't make it into `sci.idx`.
 */
export declare function closeAdapter(): Promise<void>;
