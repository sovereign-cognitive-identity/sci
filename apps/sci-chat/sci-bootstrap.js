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

/**
 * Provider env vars that .env in this app must own authoritatively.
 * Casey's shell may have inherited `ANTHROPIC_API_KEY=""` (or stale
 * `sci_t_*` values) from prior `sci-local` / `sci-vps` toggles, which
 * dotenv.config() refuses to overwrite — leaving the api server with
 * empty-string keys and silently disabling Anthropic.
 *
 * We unset them here BEFORE require()ing the server so dotenv's later
 * call lands the .env values.
 */
const PROVIDER_ENV_TO_RESET = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_KEY',
  'OPENROUTER_KEY',
  'ANTHROPIC_BASE_URL',  // Casey's old WireGuard-mesh proxy URL — must not leak
  'OPENAI_BASE_URL',
];
for (const key of PROVIDER_ENV_TO_RESET) {
  if (process.env[key] !== undefined) {
    delete process.env[key];
  }
}

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

  // ── 3. Seed local user once Mongo is up but before the server boots
  //      so the very first launch lands the user on a working login. ─
  //      Idempotent: if the user already exists, this is a no-op. The
  //      in-process Mongo means create-user can't run in a separate
  //      process — has to share this one. We do it inline here.
  await seedLocalUser();

  // ── 4. Boot the actual server ────────────────────────────────────────
  console.log('[sci-bootstrap] handing off to api/server/index.js');
  require(path.join(__dirname, 'api/server/index.js'));
})().catch((err) => {
  console.error('[sci-bootstrap] fatal:', err);
  process.exit(1);
});

/**
 * Idempotent first-run user seed. Sci's chat client runs single-user
 * locally, but LibreChat still expects a row in the `users` collection
 * to log in. We create one with deterministic credentials on the
 * very first boot of a fresh DB and skip thereafter.
 *
 * Credentials (default):
 *   email:    sci@local.host
 *   password: sci-chat-dev
 *
 * Overridable via env: SCI_LOCAL_USER_EMAIL, SCI_LOCAL_USER_PASSWORD,
 * SCI_LOCAL_USER_NAME. The DB is process-local (in-memory by default),
 * so these never leave the machine.
 *
 * Why inline rather than `npm run create-user`: in-process Mongo means
 * a separately-spawned `node config/create-user.js` would connect to
 * its own ephemeral instance and write to nothing. The seed has to
 * share the bootstrap process's Mongo handle.
 */
async function seedLocalUser() {
  // Defaults pass LibreChat's validation: real-looking domain (.host)
  // and 8+ char password. Both are documented; user can change in
  // Settings or via the SCI_LOCAL_USER_* env vars.
  const email    = process.env.SCI_LOCAL_USER_EMAIL    || 'sci@local.host';
  const password = process.env.SCI_LOCAL_USER_PASSWORD || 'sci-chat-dev';
  const name     = process.env.SCI_LOCAL_USER_NAME     || 'Sci User';
  const username = email.split('@')[0];

  // Open a side connection to the same Mongo URI to do the seed,
  // since the main api/server/index.js will open its own with mongoose
  // a moment later. Two connections to the same in-memory instance
  // share state.
  const mongoose = require('mongoose');
  const mongoUri = process.env.MONGO_URI;
  let connected = false;
  try {
    await mongoose.connect(mongoUri);
    connected = true;
    const { createModels } = require('@librechat/data-schemas');
    const { User } = createModels(mongoose);

    const existing = await User.findOne({ email }).lean();
    if (existing) {
      console.log(`[sci-bootstrap] local user already exists (${email}) — skipping seed`);
      return;
    }

    // The model has password hashing wired in pre-save; calling
    // User.create() with a plain password is the documented path
    // (see config/create-user.js for parity).
    require('module-alias')({ base: path.join(__dirname, 'api') });
    const { registerUser } = require(
      path.join(__dirname, 'api/server/services/AuthService')
    );
    const result = await registerUser(
      { email, password, confirm_password: password, name, username },
      { emailVerified: true },
    );
    if (result.status === 200) {
      console.log(`[sci-bootstrap] seeded local user ${email} / password "${password}"`);
    } else {
      console.warn(
        `[sci-bootstrap] user seed returned status ${result.status}: ${result.message}`,
      );
    }
  } catch (e) {
    console.warn('[sci-bootstrap] user seed failed (non-fatal):', e.message);
  } finally {
    if (connected) {
      // Close the side connection so the main server's mongoose.connect
      // gets a fresh handle. Otherwise the api server reuses ours and
      // its lifecycle hooks may misfire.
      await mongoose.disconnect();
    }
  }
}
