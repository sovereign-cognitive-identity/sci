import { createRequire } from 'module';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
const VECTOR_DIM = 768;
const HNSW_M = 16; // HNSW graph degree — controls recall/speed tradeoff
const HNSW_EF_CONSTRUCTION = 200;
export class CloudAdapter {
    localDir;
    db;
    index;
    vectorMap = []; // index → {id, type}
    nextVectorIndex = 0;
    constructor(localDir) {
        this.localDir = localDir;
    }
    get dbPath() { return join(this.localDir, 'sci.db'); }
    get idxPath() { return join(this.localDir, 'sci.idx'); }
    async connect() {
        if (!existsSync(this.localDir))
            mkdirSync(this.localDir, { recursive: true });
        // Pull latest from cloud before opening
        await this._downloadIfNeeded();
        // Load native addons lazily. In Bun compiled binaries, import.meta.url is
        // a virtual /$bunfs/ path, so createRequire can't find real node_modules.
        // In that case, use a file:// URL relative to the binary's actual location.
        const { _Database, HierarchicalNSW } = await (async () => {
            if (import.meta.url.includes('$bunfs')) {
                const base = 'file://' + dirname(process.execPath) + '/node_modules/';
                const sqlite = await import(base + 'better-sqlite3/lib/index.js');
                const hnswlib = await import(base + 'hnswlib-node/lib/index.js');
                return { _Database: sqlite.default, HierarchicalNSW: hnswlib.HierarchicalNSW };
            }
            else {
                const _require = createRequire(import.meta.url);
                return {
                    _Database: _require('better-sqlite3'),
                    HierarchicalNSW: _require('hnswlib-node').HierarchicalNSW,
                };
            }
        })();
        this.db = new _Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this._initSchema();
        // Load or create hnswlib index
        this.index = new HierarchicalNSW('cosine', VECTOR_DIM);
        if (existsSync(this.idxPath)) {
            this.index.readIndex(this.idxPath);
            this._loadVectorMap();
        }
        else {
            this.index.initIndex(10_000, HNSW_M, HNSW_EF_CONSTRUCTION);
        }
    }
    async disconnect() {
        await this.sync();
        this.db?.close();
    }
    // ── Schema ────────────────────────────────────────────────────────────────
    _initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS episodic_memories (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        content TEXT NOT NULL,
        source TEXT,
        agent_id TEXT,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS semantic_nodes (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        content TEXT NOT NULL,
        category TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        decay_score REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS identity_facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS semantic_edges (
        id           TEXT PRIMARY KEY,
        source_id    TEXT NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
        target_id    TEXT NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        confidence   REAL NOT NULL DEFAULT 0.7,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_id, target_id, relationship)
      );

      -- vector_map: maps hnswlib integer index → memory UUID + type
      CREATE TABLE IF NOT EXISTS vector_map (
        idx INTEGER PRIMARY KEY,
        memory_id TEXT NOT NULL,
        memory_type TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS write_queue (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'done',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS consolidation_runs (
        id TEXT PRIMARY KEY,
        ran_at TEXT NOT NULL DEFAULT (datetime('now')),
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        episodic_processed INTEGER NOT NULL DEFAULT 0,
        semantic_promoted INTEGER NOT NULL DEFAULT 0,
        semantic_reinforced INTEGER NOT NULL DEFAULT 0,
        nodes_decayed INTEGER NOT NULL DEFAULT 0,
        digest_id TEXT,
        model_used TEXT,
        duration_ms INTEGER
      );

      -- Seed default profiles
      INSERT OR IGNORE INTO profiles (id, name) VALUES
        ('${randomUUID()}', 'work'),
        ('${randomUUID()}', 'personal');
    `);
    }
    _loadVectorMap() {
        const rows = this.db.prepare('SELECT idx, memory_id, memory_type FROM vector_map ORDER BY idx').all();
        this.vectorMap = rows.map(r => ({
            index: r.idx,
            id: r.memory_id,
            type: r.memory_type,
        }));
        this.nextVectorIndex = rows.length > 0
            ? Math.max(...rows.map(r => r.idx)) + 1
            : 0;
    }
    _addToIndex(id, type, embedding) {
        const idx = this.nextVectorIndex++;
        // Resize index if needed
        if (idx >= this.index.getCurrentCount()) {
            // hnswlib-node auto-resizes; no action needed
        }
        this.index.addPoint(embedding, idx);
        this.vectorMap.push({ index: idx, id, type });
        this.db.prepare('INSERT INTO vector_map (idx, memory_id, memory_type) VALUES (?, ?, ?)')
            .run(idx, id, type);
    }
    _searchIndex(queryEmbedding, k, typeFilter) {
        if (this.nextVectorIndex === 0)
            return [];
        const actualK = Math.min(k, this.nextVectorIndex);
        const result = this.index.searchKnn(queryEmbedding, actualK);
        return result.neighbors
            .map((idx, i) => {
            const entry = this.vectorMap[idx];
            if (!entry)
                return null;
            if (typeFilter && entry.type !== typeFilter)
                return null;
            return { id: entry.id, type: entry.type, score: 1 - result.distances[i] };
        })
            .filter(Boolean);
    }
    // ── Profiles ──────────────────────────────────────────────────────────────
    async getProfiles() {
        return this.db.prepare('SELECT id, name, created_at FROM profiles').all()
            .map(p => ({ ...p, created_at: new Date(p.created_at) }));
    }
    async getProfile(name) {
        const row = this.db.prepare('SELECT id, name, created_at FROM profiles WHERE name = ?').get(name);
        if (!row)
            return null;
        return { ...row, created_at: new Date(row.created_at) };
    }
    async createProfile(name) {
        const existing = await this.getProfile(name);
        if (existing)
            return existing;
        const id = randomUUID();
        this.db.prepare('INSERT INTO profiles (id, name) VALUES (?, ?)').run(id, name);
        return { id, name, created_at: new Date() };
    }
    // ── Episodic ──────────────────────────────────────────────────────────────
    async storeEpisodic(input) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO episodic_memories (id, profile_id, content, source, agent_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.profileId, input.content, input.source ?? 'sci', input.agentId ?? null, JSON.stringify(input.metadata ?? {}));
        this._addToIndex(id, 'episodic', input.embedding);
        return { id };
    }
    // ── Semantic ──────────────────────────────────────────────────────────────
    async storeSemantic(input) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO semantic_nodes (id, profile_id, content, category, confidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.profileId, input.content, input.category ?? null, input.confidence ?? 1.0, JSON.stringify(input.metadata ?? {}));
        this._addToIndex(id, 'semantic', input.embedding);
        return { id };
    }
    async reinforceSemantic(id) {
        this.db.prepare(`UPDATE semantic_nodes SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`).run(id);
    }
    async updateDecayScore(id, score, flagged) {
        const row = this.db.prepare('SELECT metadata FROM semantic_nodes WHERE id = ?').get(id);
        if (!row)
            return;
        const meta = JSON.parse(row.metadata ?? '{}');
        if (flagged)
            meta.decay_flagged = true;
        else
            delete meta.decay_flagged;
        this.db.prepare('UPDATE semantic_nodes SET decay_score = ?, metadata = ? WHERE id = ?').run(score, JSON.stringify(meta), id);
    }
    async getSemanticNodes(profileId, options) {
        const rows = this.db.prepare(`SELECT * FROM semantic_nodes WHERE profile_id = ? AND confidence >= ? AND decay_score >= ?
       ORDER BY created_at DESC LIMIT ?`).all(profileId, options?.minConfidence ?? 0, options?.minDecay ?? 0, options?.limit ?? 1000);
        return rows.map(r => ({
            ...r,
            metadata: JSON.parse(r.metadata ?? '{}'),
            last_accessed_at: new Date(r.last_accessed_at),
            created_at: new Date(r.created_at),
        }));
    }
    // ── Identity ──────────────────────────────────────────────────────────────
    async storeIdentityFact(input) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO identity_facts (id, content, category, confidence, metadata) VALUES (?, ?, ?, ?, ?)').run(id, input.content, input.category ?? null, input.confidence ?? 1.0, JSON.stringify(input.metadata ?? {}));
        this._addToIndex(id, 'identity', input.embedding);
        return { id };
    }
    // ── Recall ────────────────────────────────────────────────────────────────
    async recall(input) {
        const fetchN = input.limit * 3;
        const results = [];
        const lowerQuery = input.query.toLowerCase();
        for (const type of input.types) {
            // Dense search via hnswlib
            const denseHits = this._searchIndex(input.queryEmbedding, fetchN, type);
            for (const hit of denseHits) {
                let row;
                if (type === 'episodic') {
                    row = this.db.prepare('SELECT id, content, metadata, occurred_at FROM episodic_memories WHERE id = ? AND profile_id = ?').get(hit.id, input.profileId);
                }
                else if (type === 'semantic') {
                    row = this.db.prepare('SELECT id, content, metadata FROM semantic_nodes WHERE id = ? AND profile_id = ?').get(hit.id, input.profileId);
                }
                else {
                    row = this.db.prepare('SELECT id, content, metadata FROM identity_facts WHERE id = ?').get(hit.id);
                }
                if (!row)
                    continue;
                // Simple keyword boost for full-text (SQLite FTS not set up for Phase 5)
                const keywordBoost = row.content.toLowerCase().includes(lowerQuery) ? 0.02 : 0;
                results.push({
                    id: hit.id, type,
                    content: row.content,
                    score: hit.score + keywordBoost,
                    metadata: JSON.parse(row.metadata ?? '{}'),
                    occurred_at: row.occurred_at ? new Date(row.occurred_at) : undefined,
                });
            }
        }
        // RRF merge and truncate
        const seen = new Map();
        results
            .sort((a, b) => b.score - a.score)
            .forEach((r, i) => {
            const rrfScore = 1 / (i + 1 + 60);
            if (!seen.has(r.id) || seen.get(r.id).score < rrfScore) {
                seen.set(r.id, { ...r, score: rrfScore });
            }
        });
        return [...seen.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, input.limit);
    }
    async queryIdentityFacts(options) {
        const limit = options?.limit ?? 20;
        let rows;
        if (options?.queryEmbedding) {
            const hits = this._searchIndex(options.queryEmbedding, limit * 3, 'identity');
            rows = hits.map(h => this.db.prepare('SELECT id, content, category, confidence, created_at, metadata FROM identity_facts WHERE id = ?').get(h.id)).filter(Boolean);
        }
        else {
            rows = (options?.category
                ? this.db.prepare('SELECT * FROM identity_facts WHERE category = ? ORDER BY confidence DESC LIMIT ?').all(options.category, limit)
                : this.db.prepare('SELECT * FROM identity_facts ORDER BY confidence DESC LIMIT ?').all(limit));
        }
        return rows.slice(0, limit).map(r => ({
            ...r,
            metadata: JSON.parse(r.metadata ?? '{}'),
            created_at: new Date(r.created_at),
        }));
    }
    // ── Consolidation ─────────────────────────────────────────────────────────
    async getEpisodicMemoriesInWindow(options) {
        const rows = this.db.prepare(`SELECT id, content FROM episodic_memories
       WHERE profile_id = ? AND occurred_at >= ? AND occurred_at < ?
         AND length(content) >= ?
         ${options.excludeDigests ? `AND (json_extract(metadata,'$.type') IS NULL OR json_extract(metadata,'$.type') != 'digest')` : ''}
       ORDER BY occurred_at ASC LIMIT ?`).all(options.profileId, options.windowStart.toISOString(), options.windowEnd.toISOString(), options.minLength ?? 20, options.limit ?? 2000);
        return rows;
    }
    async countEpisodicMemoriesInWindow(windowStart, windowEnd) {
        const row = this.db.prepare(`SELECT COUNT(*) AS c FROM episodic_memories
       WHERE occurred_at >= ? AND occurred_at < ?
         AND (json_extract(metadata,'$.type') IS NULL OR json_extract(metadata,'$.type') != 'digest')`).get(windowStart.toISOString(), windowEnd.toISOString());
        return row.c;
    }
    async findSimilarSemanticNode(embedding, profileId, threshold = 0.88) {
        const hits = this._searchIndex(embedding, 1, 'semantic');
        if (!hits[0] || hits[0].score < threshold)
            return null;
        const row = this.db.prepare('SELECT id, content FROM semantic_nodes WHERE id = ? AND profile_id = ?').get(hits[0].id, profileId);
        return row ?? null;
    }
    async getSemanticNodesForGraph(profileId, options) {
        return this.db.prepare(`SELECT id, content FROM semantic_nodes
       WHERE profile_id = ? AND confidence >= ? AND decay_score >= ?
       ORDER BY created_at DESC LIMIT ?`).all(profileId, options?.minConfidence ?? 0.6, options?.minDecay ?? 0.3, options?.limit ?? 40);
    }
    async getLastEpisodicWrite() {
        const row = this.db.prepare('SELECT occurred_at FROM episodic_memories ORDER BY occurred_at DESC LIMIT 1').get();
        return row ? new Date(row.occurred_at) : null;
    }
    async insertSemanticEdge(sourceId, targetId, relationship, confidence) {
        this.db.prepare(`INSERT OR REPLACE INTO semantic_edges (id, source_id, target_id, relationship, confidence)
       VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), sourceId, targetId, relationship, confidence);
    }
    // ── Stats ─────────────────────────────────────────────────────────────────
    async getStats() {
        const count = (sql) => this.db.prepare(sql).get().c;
        return {
            episodic: count('SELECT COUNT(*) AS c FROM episodic_memories'),
            semantic: count('SELECT COUNT(*) AS c FROM semantic_nodes'),
            identity: count('SELECT COUNT(*) AS c FROM identity_facts'),
            embeddings: this.nextVectorIndex,
            backend: this.backend,
        };
    }
    // ── Write queue ───────────────────────────────────────────────────────────
    async recordWrite(operation, payload) {
        this.db.prepare(`INSERT INTO write_queue (id, operation, payload, processed_at) VALUES (?, ?, ?, datetime('now'))`).run(randomUUID(), operation, JSON.stringify(payload));
    }
    // ── Consolidation ─────────────────────────────────────────────────────────
    async getLastConsolidationRun() {
        const row = this.db.prepare('SELECT ran_at FROM consolidation_runs ORDER BY ran_at DESC LIMIT 1').get();
        return row ? new Date(row.ran_at) : null;
    }
    async recordConsolidationRun(data) {
        this.db.prepare(`INSERT INTO consolidation_runs (id, window_start, window_end, episodic_processed,
         semantic_promoted, semantic_reinforced, nodes_decayed, digest_id, model_used, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), data.windowStart.toISOString(), data.windowEnd.toISOString(), data.episodicProcessed, data.semanticPromoted, data.semanticReinforced, data.nodesDecayed, data.digestId ?? null, data.modelUsed ?? null, data.durationMs);
    }
    // ── Sync — subclasses implement upload/download ───────────────────────────
    async sync() {
        // Flush hnswlib index to disk before syncing
        if (this.index)
            this.index.writeIndex(this.idxPath);
        return this._sync();
    }
}
//# sourceMappingURL=cloud-adapter.js.map