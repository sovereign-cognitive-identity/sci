#!/usr/bin/env node
/**
 * sci-bootstrap.js — pre-server module for sci-chat dev mode.
 *
 * What this does, in order:
 *
 *   1. Boots an in-process MongoDB via `mongodb-memory-server`. No
 *      daemon required, no Docker required, no manual install. The
 *      generated URI is written to process.env.MONGO_URI so when
 *      LibreChat's `require('./api/server/index.js')` later calls
 *      mongoose.connect(process.env.MONGO_URI), it lands on the
 *      in-process instance.
 *
 *      Caveat: the in-process Mongo is per-process. When sci-chat
 *      restarts, conversation history resets. For persistence across
 *      restarts we'll either (a) point at a real Mongo (just unset
 *      MONGO_URI=__set_by_sci_bootstrap__ in .env), or (b) ship a
 *      SQLite-backed alternative as a follow-up ticket.
 *
 *   2. Installs an undici ProxyAgent as the global fetch dispatcher.
 *      Modern Node fetch / Anthropic SDK / OpenAI SDK all use undici
 *      under the hood; setting globalDispatcher means every outbound
 *      HTTP call routes through Sci's helper at HTTPS_PROXY without
 *      patching individual clients.
 *
 *   3. Loads the actual LibreChat backend.
 *
 * Failure modes are loud: if Mongo can't start or HTTPS_PROXY isn't
 * a valid URL, we bail before the server boots so issues surface
 * immediately instead of midway through the first request.
 */

const path = require('path');

(async () => {
  console.log('[sci-bootstrap] starting…');

  // ── 1. Boot in-process MongoDB ───────────────────────────────────────
  let mongoUri;
  if (process.env.MONGO_URI && process.env.MONGO_URI !== '__set_by_sci_bootstrap__') {
    mongoUri = process.env.MONGO_URI;
    console.log(`[sci-bootstrap] using MONGO_URI from env: ${mongoUri}`);
  } else {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongo = await MongoMemoryServer.create({
      instance: { dbName: 'sci-chat' },
    });
    mongoUri = mongo.getUri();
    process.env.MONGO_URI = mongoUri;
    console.log(`[sci-bootstrap] in-process Mongo at ${mongoUri}`);
    // Keep a reference so it doesn't get GC'd while the server runs.
    globalThis.__sciMongoMemoryServer = mongo;
  }

  // ── 2. Route outbound HTTP through Sci helper ────────────────────────
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = require('undici');
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      console.log(`[sci-bootstrap] HTTPS via Sci helper at ${proxyUrl}`);
    } catch (e) {
      console.error('[sci-bootstrap] failed to install ProxyAgent:', e.message);
      console.error('[sci-bootstrap] continuing without proxy — Sci will NOT see your traffic');
    }
  } else {
    console.warn('[sci-bootstrap] HTTPS_PROXY not set — outbound calls bypass Sci');
  }

  // NODE_EXTRA_CA_CERTS must be set BEFORE Node started (it's read at
  // process startup, not lazily). The shell wrapper bin/sci-chat-dev
  // exports it from .env before invoking node. We just verify here.
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    console.warn(
      '[sci-bootstrap] NODE_EXTRA_CA_CERTS not set — TLS to Sci helper ' +
      "may fail with self-signed cert errors. The shell wrapper at " +
      'bin/sci-chat-dev sets this from .env before launching node.'
    );
  } else {
    console.log(`[sci-bootstrap] trusting CA at ${process.env.NODE_EXTRA_CA_CERTS}`);
  }

  // ── 3. Boot the actual server ────────────────────────────────────────
  console.log('[sci-bootstrap] handing off to api/server/index.js');
  require(path.join(__dirname, 'api/server/index.js'));
})().catch((err) => {
  console.error('[sci-bootstrap] fatal:', err);
  process.exit(1);
});
