export class NoopStorageAdapter {
    backend = 'noop';
    async connect() { }
    async disconnect() { }
    // Profiles — returning null on getProfile('work') is the signal that
    // makes injectMemoryContext skip recall cleanly.
    async getProfiles() { return []; }
    async getProfile(_name) { return null; }
    async createProfile(_name) {
        throw new Error('NoopStorageAdapter: cannot create profiles (memory not yet wired)');
    }
    // Episodic / semantic / identity — nothing reaches these in the v0.5
    // anonymize-only path, but we still need stubs so the type checks pass
    // and so any future caller (e.g. consolidation cron in the same process)
    // gets a sane "this backend doesn't store anything" failure mode.
    async storeEpisodic(_input) { return { id: 'noop' }; }
    async storeSemantic(_input) { return { id: 'noop' }; }
    async reinforceSemantic(_id) { }
    async updateDecayScore(_id, _s, _f) { }
    async getSemanticNodes(_profileId, _opts) { return []; }
    async storeIdentityFact(_input) { return { id: 'noop' }; }
    async recall(_input) { return []; }
    async queryIdentityFacts(_opts) { return []; }
    async getEpisodicMemoriesInWindow(_opts) { return []; }
    async countEpisodicMemoriesInWindow(_a, _b) { return 0; }
    async findSimilarSemanticNode(_embedding, _profileId, _threshold) { return null; }
    async getSemanticNodesForGraph(_profileId, _opts) { return []; }
    async getLastEpisodicWrite() { return null; }
    async insertSemanticEdge(_src, _tgt, _rel, _conf) { }
    async getStats() {
        return { episodic: 0, semantic: 0, identity: 0, embeddings: 0, backend: 'noop' };
    }
    async recordWrite(_op, _payload) { }
    async getLastConsolidationRun() { return null; }
    async recordConsolidationRun(_data) { }
    async sync() {
        return { uploaded: 0, downloaded: 0 };
    }
}
//# sourceMappingURL=storage-stub.js.map