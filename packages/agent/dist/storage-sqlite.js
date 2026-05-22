/**
 * Local SQLite-backed StorageAdapter for the agent (SCI-118).
 *
 * Extends CloudAdapter with real control plane sync (EP5):
 *   - _sync()               → encrypt new memories, push to POST /api/memories
 *   - _pullFromControlPlane → pull blobs since last sync, decrypt, import into local DB
 *   - connect()             → super.connect() (open DB) then pull
 *
 * Encryption: AES-256-GCM with a per-device key at ~/.sci/enc.key.
 * The control plane stores ciphertext only — plaintext never leaves the device.
 *
 * Offline behaviour: failed pushes are buffered to ~/.sci/pending-sync.ndjson
 * and retried on the next sync cycle.
 */
import { CloudAdapter } from '../../core/dist/storage/cloud-adapter.js';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { homedir } from 'os';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

// ── Encryption helpers ────────────────────────────────────────────────────────

function encryptBlob(data, key) {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(data), 'utf-8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, encrypted]).toString('base64');
}

function decryptBlob(b64, key) {
    const buf = Buffer.from(b64, 'base64');
    const nonce = buf.subarray(0, NONCE_LEN);
    const tag = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const data = buf.subarray(NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8'));
}

// ── Sync state ────────────────────────────────────────────────────────────────

function loadSyncState(configDir) {
    const path = join(configDir, 'sync.json');
    if (!existsSync(path)) return { lastSyncAt: null, lastPullAt: null };
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { lastSyncAt: null, lastPullAt: null }; }
}

function saveSyncState(configDir, data) {
    writeFileSync(join(configDir, 'sync.json'), JSON.stringify(data, null, 2) + '\n');
}

// ── Enc key ───────────────────────────────────────────────────────────────────

function loadEncKey(configDir) {
    const keyPath = join(configDir, 'enc.key');
    if (!existsSync(keyPath)) return null;
    return Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'base64');
}

export function generateEncKey(configDir) {
    const keyPath = join(configDir, 'enc.key');
    if (existsSync(keyPath)) return;
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class SqliteStorageAdapter extends CloudAdapter {
    backend = 'sqlite-local';
    #configDir;
    #controlPlaneUrl;
    #agentToken;

    constructor(localDir, options = {}) {
        super(localDir);
        this.#configDir = options.configDir ?? join(homedir(), '.sci');
        this.#controlPlaneUrl = options.controlPlaneUrl ?? 'https://control.sci.sh';
        const tokenPath = join(this.#configDir, 'agent.token');
        this.#agentToken = existsSync(tokenPath)
            ? readFileSync(tokenPath, 'utf-8').trim()
            : null;
    }

    async _downloadIfNeeded() {
        /* noop — blob sync runs after connect() opens the DB */
    }

    async connect() {
        await super.connect();
        if (this.#agentToken) {
            await this._pullFromControlPlane().catch(err => {
                process.stderr.write(`[sci] memory pull skipped (${err.message})\n`);
            });
        }
    }

    // ── Pull (download) ───────────────────────────────────────────────────────

    async _pullFromControlPlane() {
        const encKey = loadEncKey(this.#configDir);
        if (!encKey) return;

        const syncState = loadSyncState(this.#configDir);
        const sinceParam = syncState.lastPullAt
            ? `?since=${encodeURIComponent(syncState.lastPullAt)}`
            : '';

        const res = await fetch(`${this.#controlPlaneUrl}/api/memories${sinceParam}`, {
            headers: { authorization: `Bearer ${this.#agentToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`GET /api/memories → ${res.status}`);

        const { blobs } = await res.json();
        if (!blobs?.length) return;

        let imported = 0;
        for (const blob of blobs) {
            try {
                const record = decryptBlob(blob.encryptedBlob, encKey);
                await this._importBlobRecord(blob.blobType, record);
                imported++;
            } catch (err) {
                process.stderr.write(`[sci] blob import failed (id=${blob.id}): ${err.message}\n`);
            }
        }

        saveSyncState(this.#configDir, { ...syncState, lastPullAt: new Date().toISOString() });
        if (imported > 0) {
            // Flush HNSW index to disk so the MCP server can read the new vectors.
            this.index.writeIndex(this.idxPath);
            process.stderr.write(`[sci] imported ${imported} memory blob(s) from control plane\n`);
        }
    }

    async _importBlobRecord(blobType, record) {
        // Profile: resolve local UUID by name so IDs from other devices work.
        const profileId = record.profileName
            ? await this._resolveProfileId(record.profileName)
            : record.profile_id;

        switch (blobType) {
            case 'episodic': {
                const exists = this.db.prepare('SELECT 1 FROM episodic_memories WHERE id = ?').get(record.id);
                if (exists) return;
                this.db.prepare(
                    `INSERT INTO episodic_memories (id, profile_id, content, source, agent_id, occurred_at, metadata)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                ).run(record.id, profileId, record.content, record.source ?? 'sync',
                    record.agent_id ?? null,
                    record.occurred_at ?? new Date().toISOString(),
                    JSON.stringify(record.metadata ?? {}));
                if (record.embedding) this._addToIndex(record.id, 'episodic', record.embedding);
                break;
            }
            case 'semantic': {
                const exists = this.db.prepare('SELECT 1 FROM semantic_nodes WHERE id = ?').get(record.id);
                if (exists) return;
                this.db.prepare(
                    `INSERT INTO semantic_nodes (id, profile_id, content, category, confidence, metadata)
                     VALUES (?, ?, ?, ?, ?, ?)`
                ).run(record.id, profileId, record.content,
                    record.category ?? null, record.confidence ?? 1.0,
                    JSON.stringify(record.metadata ?? {}));
                if (record.embedding) this._addToIndex(record.id, 'semantic', record.embedding);
                break;
            }
            case 'identity': {
                const exists = this.db.prepare('SELECT 1 FROM identity_facts WHERE id = ?').get(record.id);
                if (exists) return;
                this.db.prepare(
                    `INSERT INTO identity_facts (id, content, category, confidence, metadata)
                     VALUES (?, ?, ?, ?, ?)`
                ).run(record.id, record.content,
                    record.category ?? null, record.confidence ?? 1.0,
                    JSON.stringify(record.metadata ?? {}));
                if (record.embedding) this._addToIndex(record.id, 'identity', record.embedding);
                break;
            }
        }
    }

    async _resolveProfileId(profileName) {
        const row = this.db.prepare('SELECT id FROM profiles WHERE name = ?').get(profileName);
        if (row) return row.id;
        // Create the profile if it doesn't exist locally yet.
        const { id } = await this.createProfile(profileName);
        return id;
    }

    // ── Push (upload) ─────────────────────────────────────────────────────────

    async _sync() {
        if (!this.#agentToken) return { uploaded: 0, downloaded: 0 };
        const encKey = loadEncKey(this.#configDir);
        if (!encKey) return { uploaded: 0, downloaded: 0 };

        // Drain pending-sync.ndjson — blobs that failed to push during a previous
        // sync (offline, 5xx, timeout). Already encrypted; just re-POST them.
        const pendingPath = join(this.#configDir, 'pending-sync.ndjson');
        if (existsSync(pendingPath)) {
            const lines = readFileSync(pendingPath, 'utf-8').split('\n').filter(l => l.trim());
            if (lines.length > 0) {
                const failed = [];
                for (const line of lines) {
                    let entry;
                    try { entry = JSON.parse(line); } catch { continue; }
                    try {
                        const res = await fetch(`${this.#controlPlaneUrl}/api/memories`, {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                authorization: `Bearer ${this.#agentToken}`,
                            },
                            body: JSON.stringify(entry),
                            signal: AbortSignal.timeout(8_000),
                        });
                        if (!res.ok) failed.push(line);
                    } catch {
                        failed.push(line);
                    }
                }
                if (failed.length === 0) {
                    unlinkSync(pendingPath);
                    process.stderr.write(`[sci] drained ${lines.length} pending blob(s)\n`);
                } else {
                    writeFileSync(pendingPath, failed.join('\n') + '\n');
                    if (failed.length < lines.length)
                        process.stderr.write(`[sci] drained ${lines.length - failed.length}/${lines.length} pending blobs; ${failed.length} still offline\n`);
                }
            }
        }

        const syncState = loadSyncState(this.#configDir);
        // SQLite datetime() format: 'YYYY-MM-DD HH:MM:SS'
        const since = syncState.lastSyncAt
            ? new Date(syncState.lastSyncAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
            : '1970-01-01 00:00:00';

        const toUpload = [
            ...this.db.prepare(
                `SELECT e.id, e.profile_id, e.content, e.source, e.agent_id, e.occurred_at, e.metadata,
                        p.name AS profile_name
                   FROM episodic_memories e JOIN profiles p ON p.id = e.profile_id
                  WHERE e.created_at > ? ORDER BY e.created_at ASC`
            ).all(since).map(r => ({ blobType: 'episodic', record: r })),

            ...this.db.prepare(
                `SELECT s.id, s.profile_id, s.content, s.category, s.confidence, s.metadata,
                        p.name AS profile_name
                   FROM semantic_nodes s JOIN profiles p ON p.id = s.profile_id
                  WHERE s.created_at > ? ORDER BY s.created_at ASC`
            ).all(since).map(r => ({ blobType: 'semantic', record: r })),

            ...this.db.prepare(
                `SELECT id, content, category, confidence, metadata
                   FROM identity_facts
                  WHERE created_at > ? ORDER BY created_at ASC`
            ).all(since).map(r => ({ blobType: 'identity', record: r })),
        ];

        if (!toUpload.length) return { uploaded: 0, downloaded: 0 };

        // Cap per-sync batch to avoid overwhelming the control plane on first run.
        // Subsequent syncs will pick up where this left off via lastSyncAt.
        const BATCH_LIMIT = 200;
        const batch = toUpload.slice(0, BATCH_LIMIT);
        if (toUpload.length > BATCH_LIMIT) {
            process.stderr.write(`[sci] sync: ${toUpload.length} memories pending, uploading first ${BATCH_LIMIT}\n`);
        }

        let uploaded = 0;

        for (const { blobType, record } of batch) {
            // Look up the embedding from the vector map so the recipient can re-index.
            const embeddingEntry = this.vectorMap.find(e => e.id === record.id);
            const embedding = embeddingEntry ? this.index.getPoint(embeddingEntry.index) : null;

            const payload = {
                ...record,
                profileName: record.profile_name,
                embedding,
            };
            delete payload.profile_name; // normalise key name

            let encryptedBlob;
            try {
                encryptedBlob = encryptBlob(payload, encKey);
            } catch (err) {
                process.stderr.write(`[sci] encrypt failed for ${record.id}: ${err.message}\n`);
                continue;
            }

            try {
                const res = await fetch(`${this.#controlPlaneUrl}/api/memories`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${this.#agentToken}`,
                    },
                    body: JSON.stringify({ blobType, encryptedBlob }),
                    signal: AbortSignal.timeout(8_000),
                });
                if (res.ok) {
                    uploaded++;
                    // Save progress incrementally so interruptions don't lose work.
                    // Use occurred_at (what's in the record) as the sync watermark.
                    const ts = record.occurred_at ?? record.created_at;
                    if (ts) {
                        saveSyncState(this.#configDir, { ...syncState, lastSyncAt: new Date(ts).toISOString() });
                    }
                } else {
                    appendFileSync(pendingPath, JSON.stringify({ blobType, encryptedBlob }) + '\n');
                }
            } catch {
                appendFileSync(pendingPath, JSON.stringify({ blobType, encryptedBlob }) + '\n');
            }
        }

        saveSyncState(this.#configDir, { ...syncState, lastSyncAt: new Date().toISOString() });
        if (uploaded > 0) process.stderr.write(`[sci] pushed ${uploaded} memory blob(s) to control plane\n`);
        return { uploaded, downloaded: 0 };
    }
}
//# sourceMappingURL=storage-sqlite.js.map
