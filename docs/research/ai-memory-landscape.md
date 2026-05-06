# Portable AI Memory Landscape

A map of projects working to move AI memory out of proprietary walled gardens — toward portable, user-owned, hardware-secured "memory passports" — and where Sci sits among them.

> **Date:** May 2026
> **Purpose:** competitive positioning, overlap analysis, cooperation surfaces.
> **Audience:** Sci maintainers, contributors, and partners.

---

## 1. The four layers

Projects in this space cluster into four roles. Most try to occupy one or two; few cover all four.

| Layer | What it answers | Projects |
|---|---|---|
| **Interchange** | Can my memory move between providers without semantic loss? | PAM, MIF, MCP |
| **Sovereignty** | Where does the data live, and who controls it? | Plurality, Personal AI, Persistent AI Memory, MemPalace, Sci |
| **Security** | Can it stay confidential on a hostile host? | MemTrust, Intel TDX × Google, Kinic |
| **Portability** | Can I carry the whole stack with me? | KoboldCpp + VSCodium + USB |

```
┌─ Interchange ─────────────────────────────┐
│  PAM · MIF · MCP                          │
├─ Sovereignty ─────────────────────────────┤
│  Plurality · Personal AI · Persistent AI  │
│  Memory · MemPalace · Sci                 │
├─ Security ────────────────────────────────┤
│  MemTrust · Intel TDX × Google · Kinic    │
├─ Portability ─────────────────────────────┤
│  KoboldCpp + VSCodium + USB               │
└───────────────────────────────────────────┘
```

Sci sits primarily in **Interchange + Sovereignty**, with optional reach into Security via TDX deployment and Portability via USB-bundle distribution.

---

## 2. Project-by-project

### Interchange formats

**Portable AI Memory (PAM)** — Apache-2.0 spec + CC-BY-4.0 docs + Python SDK. Defines 11 memory types with provenance and content hashing. Solo maintainer (Daniel Gines), ~6 GitHub stars, very early. Claims unilateral mappings to ChatGPT/Claude/Grok/Gemini/Copilot, but no provider has endorsed.

**Memory Interchange Format (MIF)** — Competing spec by zircote. JSON-LD + Markdown with W3C PROV provenance. Also early-stage. Tracks PAM closely in scope.

**Model Context Protocol (MCP)** — Anthropic's open protocol, **donated to the Linux Foundation's Agentic AI Foundation (AAIF) in December 2025**, with Anthropic, OpenAI, Google, AWS, Microsoft, Block, Cloudflare, Bloomberg as platinum members. ~10 000 active public servers, ~97 M monthly SDK downloads, first-class client support across ChatGPT, Claude, Cursor, Gemini, Copilot, VS Code. This is Sci's substrate, not a peer.

### Memory layers / runtimes

**Mem0** — Open-source memory layer (Apache 2.0) plus hosted SaaS. **Default architecture: Postgres for relational + Qdrant for vectors; pgvector is a supported alternative; MCP exposed via "OpenMemory MCP."** Series A $24 M (Oct 2025) led by Basis Set, YC, Peak XV. 41 k+ GitHub stars, 13 M+ Python downloads, API calls grew 35 M → 186 M across Q1–Q3 2025. **AWS picked Mem0 as the exclusive memory provider for its Agent SDK.** This is the dominant, well-funded incumbent — and it occupies the same architectural niche as Sci.

**Plurality Network** — Closed-source SaaS startup (London, founded 2023, seed Feb 2024 from Outlier Ventures + Futureverse). Chrome extension + hosted "Open Context Layer" memory store, MCP-connected to ChatGPT/Claude/Gemini/Copilot/Cursor/Windsurf. Markets "TEE + MPC" security but the TEE migration is still labelled "soon." ~2 000 reported users; on AppSumo. Tagline overlaps heavily with Sci ("portable, privacy-first, universal AI memory") but it's a hosted service.

**Personal AI** — ~$27 M raised. Bets on per-user **Small Language Models with memory baked into weights**, deployed on edge / NVIDIA AI Grid. Production launch with Comcast (March 2026): 15 ms TTFT, $0.02 / 1 M output tokens. Different abstraction from Sci — model weights vs. external store — but adjacent in audience.

**Persistent AI Memory** *(savantskie)* — Single-developer MIT Python project, MCP server with SQLite + pluggable embeddings (Ollama / LM Studio / OpenAI). 226 stars, v1.5.0 (March 28, 2026). Recently emphasized stripping hard-coded paths in favour of env vars — this is the project the original prompt called out.

**MemPalace** — MIT, Python, SQLite + ChromaDB, 29 MCP tools, "method-of-loci" metaphor. Created by Milla Jovovich + Ben Sigman; viral launch April 6, 2026. Reported 51 k+ stars and a v3.3.4 release on May 1. **Credibility caveat:** the headline "96.6 % R@5 on LongMemEval" and "v4 100 %" benchmark claims have been substantively challenged — independent analysis shows the score reflects ChromaDB's default embeddings (not the palace structure) and the v4 hybrid score appears to come from inspecting failing dev-set items.

### Security / hardware

**MemTrust** — Academic preprint (arXiv 2601.07004, Jan 2026). Five-layer TEE-protected memory architecture supporting SGX, SEV-SNP, TDX, Nitro, CCA. Claims a 20 k-LOC implementation (Rust + Python) but **no public OSS release found**. Treat as architectural reference, not a product.

**Intel TDX × Google** — Production confidential-computing platform. Google Cloud's Confidential VMs and Confidential GKE Nodes now support NVIDIA H100 GPUs on A3 with TDX-on-CPU plus NVIDIA CC-on-GPU. Pure substrate — Sci could deploy a Pro tier inside a TDX-protected VM for hardware-attested sovereignty.

**Kinic AI** — Decentralized vector DB + zkML stack on the Internet Computer (ICP) blockchain, governed by an SNS DAO ($KINIC token). Real engineering (JOLTx zkVM, ~3 core devs funded via DAO grants) but no substantiated user metrics, MCP integration, or production traction beyond a 2022 Chrome plugin. Adjacent trust model (blockchain + ZK), not a direct competitor for users who want a local Postgres DB.

### Portability patterns

**KoboldCpp + VSCodium + USB** — A pattern, not a project. KoboldCpp (LostRuins, single-binary GGUF runner) + portable VSCodium / Continue plugin running off a VeraCrypt-encrypted USB-SSD. The adjacent **techjarves/USB-Uncensored-LLM** project packages a fully air-gapped Python+engine bundle (uses Ollama). Provides the *inference* sovereignty story — Sci could provide the *memory* sovereignty story bundled alongside it.

---

## 3. Where Sci overlaps and where it doesn't

| Project | Architectural overlap with Sci | Audience overlap | Verdict |
|---|---|---|---|
| **Mem0** | High — Postgres+pgvector, MCP, OSS core | Very high | **Direct competitor** |
| **Persistent AI Memory** | Medium — different stack (Python/SQLite) | Very high | Sibling / peer |
| **MemPalace** | Medium — different stack (Python/SQLite/Chroma) | High | Noisy neighbour |
| **Plurality Network** | Low — closed SaaS | High | Positioning rival |
| **PAM / MIF** | Low — they're specs, Sci is a runtime | n/a | Substrate / lever |
| **MCP / AAIF** | n/a — substrate | n/a | Standards venue |
| **TDX × Google** | n/a — substrate | n/a | Deployment target |
| **MemTrust** | Architectural reference only | n/a | Future Pro-tier blueprint |
| **Personal AI** | Low — memory in model weights, not external store | Medium | Adjacent |
| **Kinic** | Low — different trust model (blockchain) | Low | Adjacent |
| **KoboldCpp + USB** | Complementary | Medium | Distribution partner |

The pattern: Sci competes hardest with the **OSS local-first MCP-memory peer group** (Mem0 OSS core, Persistent AI Memory, MemPalace). It is *substrate-aligned* with MCP/AAIF, PAM/MIF, TDX, and KoboldCpp. It is *positioning-aligned but architecturally distant* from Plurality and Personal AI.

---

## 4. Positioning for Sci

Sci's only durable wedges against a $24 M-funded, AWS-distributed Mem0 are things Mem0 cannot easily copy without abandoning its business model:

1. **Sovereignty by default, not as a setting.** Mem0's defaults push toward hosted SaaS and cloud embedding APIs. Sci's defaults are local Postgres+pgvector and BGE-base-en-v1.5 embeddings — no per-query data exposure, ever. This contrast must be the lede on the home page, the README, and every conference talk.

2. **Anonymization on the egress side.** Sci's anonymization proxy (Phase 3) is unique in this peer set. None of Mem0, Persistent AI Memory, MemPalace, or Plurality strip identity before forwarding to cloud LLMs. This is the feature most credibly defended on grounds of *privacy as architecture*, not *privacy as policy*.

3. **Spec leadership over feature parity.** Implementing PAM and/or MIF (and contributing back), and engaging AAIF working groups on portable-memory schemas, costs Sci weeks of work and buys disproportionate credibility — exactly the move a sovereignty project can make that a VC-backed startup typically won't prioritize.

4. **Technical credibility as differentiator from MemPalace.** MemPalace will dominate search results for "AI memory" for the next several months on celebrity attention. Sci's counter-positioning is *no inflated benchmarks*, *honest evaluation*, *coherent identity story*. Resist the urge to publish a competing benchmark with a bigger number.

5. **TypeScript / Node ergonomics.** The closest local-first OSS peers (Persistent AI Memory, MemPalace) are Python. The MCP ecosystem skews toward Node/TS. Sci is the natural choice for developers already inside that toolchain — make sure that's loud in the docs.

What Sci should *not* try to do:

- Compete with Mem0 on hosted SaaS or enterprise sales motions.
- Compete with Personal AI on per-user model training.
- Compete with Kinic on blockchain or zk infrastructure.
- Compete with MemPalace on viral marketing or benchmarks.

---

## 5. Cooperation map

Concrete cooperation surfaces, ranked by leverage-per-effort.

### High leverage, low effort

- **PAM and MIF interchange.** Both are solo-maintained, Apache-2.0/MIT, looking for adopters. Implement export/import in `@sci/cli` (a few hundred lines of TS) and contribute a TS reference implementation to PAM and a JSON-LD profile to MIF. Possible meta-move: propose a merger or joint working group between the two specs at AAIF.
- **AAIF working-group engagement.** With MCP under the Linux Foundation, the venue for portable-memory standards is now public and chartered. Attend the working-group calls, publish Sci's MCP memory-server reference, propose extensions for sovereignty-first memory.
- **Persistent AI Memory (savantskie).** Closest sibling. Co-author an interchange schema (PAM- or MIF-shaped) so users can move between Sci and Persistent AI Memory without losing data. Cross-link in READMEs.

### Medium leverage, medium effort

- **KoboldCpp + USB-Uncensored-LLM bundle.** Submit a "Sci on a stick" recipe — portable Postgres + Sci binary + BGE model — to USB-Uncensored-LLM or a similar project. Distribution via the local-LLM hobbyist community is high-affinity for Sci's positioning.
- **MemTrust authors.** Cite the paper in Sci's architecture docs, email the authors, and offer Sci as a candidate runtime they could harden with their TEE work. Could become a co-authored paper or grant proposal.
- **Mem0 — pgvector compatibility.** Mem0 already supports pgvector. There may be an OSS-side opportunity to make Sci a drop-in Mem0 backend for users who want sovereign defaults with Mem0's API surface. This is *competitive cooperation* — adoption of Sci as plumbing — and should be approached with care because it cedes the front door to Mem0.

### Lower leverage, watch only

- **Plurality Network.** Closed SaaS. Possible "bring your own Sci-backed Open Context bucket" integration, but their business model wants the memory hosted. Watch for tone-shift from them on TEE delivery.
- **Personal AI.** Proprietary. No public extension points. Imaginable as a context source for their SLMs but no public path.
- **Kinic.** Different trust model and crypto-token governance overhead. Track for zkML primitives that might inform a future Sci anonymization mode.
- **Intel TDX × Google.** Use as a deployment target for a Pro/enterprise tier; no cooperation needed beyond standard partner channels.

### Avoid

- **MemPalace.** Architecturally adjacent but credibility-impaired. Engaging publicly invites being framed as a competitor in the celebrity narrative; engaging privately wastes time. Note in internal docs and move on.

---

## 6. Recommended next moves

In rough order:

1. **Publish a one-page positioning brief** on the website that names Mem0 explicitly and contrasts sovereignty defaults. Don't be coy.
2. **Ship PAM/MIF import-export in `@sci/cli`** behind `sci import --pam` and `sci export --pam`. Mirror for MIF.
3. **Open AAIF engagement** — register a maintainer on the relevant working group, post Sci's MCP memory-server reference.
4. **Add a "compared to" page in the docs** covering Mem0, Persistent AI Memory, MemPalace, and Plurality with honest, sourced trade-offs.
5. **Reach out to savantskie** (Persistent AI Memory) about a shared interchange schema and reciprocal README links.
6. **Email the MemTrust authors** with the Sci architecture docs and an offer to be a runtime case study.
7. **Draft a "Sci on a stick" portable-bundle recipe** for the local-LLM crowd.

---

## Sources

- PAM: <https://github.com/portable-ai-memory/portable-ai-memory>, <https://portable-ai-memory.org/>
- MIF: <https://github.com/zircote/MIF>
- MCP / AAIF: <https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation>, <https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation>, <https://modelcontextprotocol.io/specification/2025-11-25>
- Mem0: <https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/>, <https://docs.mem0.ai/components/vectordbs/dbs/pgvector>, <https://mem0.ai/blog/how-to-make-your-clients-more-context-aware-with-openmemory-mcp>
- MemTrust: <https://arxiv.org/abs/2601.07004>
- Intel TDX × Google: <https://www.intel.com/content/www/us/en/security/security-practices/blogs/google-collaboration-strengthen-intel-tdx.html>, <https://cloud.google.com/blog/products/identity-security/expanding-confidential-computing-for-ai-workloads-next24>
- Kinic: <https://www.kinic.io/>, <https://dashboard.internetcomputer.org/sns/7jkta-eyaaa-aaaaq-aaarq-cai>
- Plurality: <https://plurality.network/>, <https://pitchbook.com/profiles/company/597172-87>
- Personal AI: <https://www.personal.ai/>, <https://www.globenewswire.com/news-release/2026/03/17/3257092/0/en/Personal-AI-s-Memory-Based-Small-Language-Models-Deliver-Hyper-Personalized-Experiences-on-Comcast-s-AI-Grid-Powered-by-NVIDIA.html>
- Persistent AI Memory: <https://github.com/savantskie/persistent-ai-memory>
- MemPalace: <https://github.com/MemPalace/mempalace>, <https://cybernews.com/ai-news/milla-jovovich-mempalace-memory-tool/>, <https://penfieldlabs.substack.com/p/milla-jovovich-just-released-an-ai>
- KoboldCpp / USB: <https://github.com/lostruins/koboldcpp>, <https://github.com/techjarves/USB-Uncensored-LLM>
