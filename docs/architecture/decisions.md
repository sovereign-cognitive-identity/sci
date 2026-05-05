# Stack Decisions

Every architectural choice in Sci was deliberate. Here's what we chose, what we rejected, and why.

## Postgres + pgvector over Milvus / Qdrant

**Chosen:** Postgres + pgvector  
**Rejected:** Milvus, Qdrant, Pinecone

A dedicated vector store adds an entire service dependency for a capability Postgres already has. pgvector colocates relational data (profiles, write queue, auth) with vector data. For the scale Sci operates at — millions of memories per user, not billions — pgvector's HNSW index is more than sufficient. Simpler ops, simpler backup, simpler sovereignty story.

## Custom TypeScript MCP server over OpenMemory

**Chosen:** @sci/mcp (custom)  
**Rejected:** OpenMemory (Mem0), Letta/MemGPT

OpenMemory is tied to Mem0's infrastructure and Python ecosystem. Letta/MemGPT has strong opinions about agent architecture. Sci needs to serve any MCP-compatible agent without being opinionated about the agent's internals. Custom TypeScript gives full control over the MCP tool surface, auth tiers, and profile scoping.

## SQLite + hnswlib for cloud backends over "Postgres everywhere"

**Chosen:** SQLite + hnswlib (cloud)  
**Rejected:** Remote Postgres / managed database

Cloud storage backends (Dropbox, S3, iCloud) need to work with files — not running servers. SQLite is the right database for "a file that is a database." hnswlib is a fast HNSW implementation that works without a server process. Two files in your Dropbox is a more honest implementation of "your data is literally in your Dropbox" than a Postgres instance that syncs to Dropbox.

## LLM Wiki v2 consolidation pattern over real-time summarization

**Chosen:** Nightly batch consolidation  
**Rejected:** Real-time summarization on every write

Summarizing on every write is expensive and lossy. Storing raw episodic memories preserves the original signal. Nightly consolidation promotes high-value items to semantic nodes using Ebbinghaus decay scoring — the same forgetting curve the human brain uses. The implementation is ~300 lines and is fully auditable.

## BGE-base-en-v1.5 (local) over Voyage AI as default

**Chosen:** FastEmbed + BGE-base-en-v1.5 (local, 768-dim)  
**Rejected:** Voyage AI as default, OpenAI embeddings

Sovereignty by default. Every embedding query to a cloud provider is a data exposure event. Local embeddings mean raw memory content never leaves the machine for the embedding step. Voyage AI (already in use in Threadline) is available as a Pro tier upgrade for users who want higher quality and accept the tradeoff.

## SHA-256 hash chain provenance over blockchain

**Chosen:** SHA-256 hash of token, stored only  
**Rejected:** Blockchain, distributed ledger

Tamper-evident without overhead. Only the hash of a token is stored — the plaintext is shown once and never persisted. A developer can verify token integrity with standard cryptographic tools.

## Compromise.js NER over spaCy

**Chosen:** compromise.js (pure JavaScript)  
**Rejected:** spaCy (Python)

spaCy is more accurate, but it requires a Python sidecar process, a model download, and a subprocess communication layer. Compromise.js runs in-process with no external dependencies. For the NER quality needed (PERSON, PLACE, ORG detection in English), compromise.js is sufficient and the operational simplicity is worth more than marginal accuracy gains. Custom entity loading from `identity_facts` covers the gap for user-specific names.

## RRF (k=60) over learned re-ranking

**Chosen:** Reciprocal Rank Fusion (k=60)  
**Rejected:** Learned re-rankers (cross-encoders, ColBERT)

RRF is deterministic, has no additional inference cost, and has been state-of-the-art for hybrid retrieval since 2009. Learned re-rankers would require an additional model call per query. For a system that already runs two DB queries per recall, adding a third inference step is a significant latency increase with marginal benefit at this scale.

## MCP stdio transport over HTTP

**Chosen:** stdio (spawned by client)  
**Rejected:** HTTP/SSE server

For local use, stdio is simpler — no port management, no authentication surface beyond the token, no server process to manage. The client spawns the server and owns its lifecycle. HTTP transport is available for Phase 6+ multi-client scenarios but isn't needed for the initial use case.
