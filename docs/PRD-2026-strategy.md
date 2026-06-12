# Sci PRD — "The Privacy Layer Between You and Every AI"

_Version 1.0 · 2026-06-10 · Derived from `sci-strategy.html` (strategy synthesis)_

## 1. Background & Problem

LLM providers see everything users send them. Existing PII tooling (Presidio, LLM Guard, gateway guardrails) performs **destructive one-way redaction** — usable for logging, useless for conversation, because the model's response can't reference the redacted entities. No OSS or commercial product offers **reversible round-trip anonymization** (anonymize outbound → infer → de-anonymize inbound) combined with **local-first memory**.

Sci has a working alpha of exactly this, but: it's Claude-only, macOS-only, distributed as a monolith, and its memory consolidation is stubbed.

## 2. Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Own the "reversible anonymization for LLMs" category | Sci/sci-anonymizer is the top reference when the pattern is searched/discussed; ≥1 external project embeds it |
| G2 | Cross-provider reality | Round-trip works for Claude, OpenAI, Google, and one local runtime (Ollama) |
| G3 | Frictionless adoption | Fresh machine → working MCP server in one command, on macOS + Linux |
| G4 | Credibility via honesty | Public NER benchmark vs Presidio, including losses |
| G5 | Sticky retention | Memory consolidation v1 driven by real alpha-user feedback |

### Non-Goals (explicit, from strategy)

- Competing with Mem0 on memory features (graph memory, benchmarks arms race)
- DID/Solid/SSI integration (revisit 2027+)
- Enterprise compliance features (SOC2 tooling, RBAC, audit dashboards)
- Completing all sync adapters (Dropbox/S3 deferred; one adapter only)
- Windows support (defer until pulled by demand)

## 3. Personas

- **P1 — Privacy-conscious power user**: uses Claude/ChatGPT daily, wants providers to never see real names/employers/health details. Installs via Homebrew/npx.
- **P2 — Agent/tool developer**: building an MCP server, agent framework, or LLM proxy; wants an embeddable anonymization library, not an app.
- **P3 — Alpha tester (existing)**: macOS, Claude Code user, already running the proxy.

---

## Phase 0 — Land the Alpha (pre-work, ~1 week)

Stabilize what exists before building on it.

### Epic 0.1 — Merge & release current branch
- Merge PR #36 (proxy stability SCI-259/260 + embedder cold-start fix).
- Cut a tagged alpha release; update alpha tester tarballs.
- Triage open alpha-tester feedback into the backlog.

**DoD (Phase 0)**
- [ ] PR #36 merged to `main`; CI green
- [ ] Tagged release `vX.Y.Z-alpha` published; testers notified
- [ ] Embedder cold start verified sub-second on a cold macOS machine
- [ ] Proxy runs 72h under normal use with zero crashes (SCI-259/260 repro included)
- [ ] All alpha feedback captured as tickets with phase labels

---

## Phase 1 — Extract the Wedge (Month 1)

`sci-anonymizer` becomes a standalone, embeddable OSS component.

### Epic 1.1 — Repo extraction & API hardening
- Extract `core/crates/sci-anonymizer` to its own repo (`sovereign-cognitive-identity/sci-anonymizer`) with history preserved.
- Define the stable public API: `anonymize(text, session) -> (text, session)`, `deanonymize(text, session) -> text`, session serialization (explicit, documented format with versioning).
- Semver policy, CHANGELOG, MSRV, permissive license (Apache-2.0 OR MIT).
- Monorepo consumes it as a crates.io dependency (no path dep on main).

### Epic 1.2 — Multi-language bindings
- WASM build (`wasm-bindgen`) + npm package `@sci/anonymizer` with TS types.
- Python binding (PyO3/maturin) published to PyPI.
- Parity test suite runs identically across Rust/WASM/Python (port existing 17 integration + 3 parity tests).

### Epic 1.3 — Public benchmark vs Presidio
- Select/assemble a public PII corpus (+ Sci's edge-case corpus from SCI-195/196/197).
- Benchmark harness: precision/recall per entity type (PERSON, ORG, PLACE, EMAIL, PHONE, URL, HANDLE) for sci-anonymizer vs Presidio, plus **round-trip fidelity** (a metric Presidio can't score on).
- Publish results in the repo — including categories where Sci loses.

**DoD (Phase 1)**
- [ ] `sci-anonymizer` crate published on crates.io; npm + PyPI packages published
- [ ] Main monorepo builds against the published crate
- [ ] Cross-language parity suite green in CI (Rust, WASM/Node, Python)
- [ ] Session map serialization format documented and versioned
- [ ] Benchmark report committed with reproducible harness (`make bench` regenerates)
- [ ] README shows a 5-line embed example for each language
- [ ] No regressions in the integrated Sci proxy (existing integration tests pass)

---

## Phase 2 — MCP as Primary Distribution (Month 2)

### Epic 2.1 — Cross-platform one-command install
- `npx @sci/mcp` (or `brew install sci` / Docker image) brings up the MCP server with zero manual config.
- Linux support: build/test sci-embeddings ONNX path on Linux x86_64 + aarch64.
- Storage default that requires no Postgres setup: bundled SQLite path promoted from stub to tested first-class backend (Postgres remains the power option).
- First-run experience: auto-download BGE model with progress, health check, sample `claude mcp add` snippet printed.

### Epic 2.2 — MCP surface polish
- Document all six tools (`memory_*` ×4, `message_anonymize/deanonymize`) with examples.
- Anonymization-session lifecycle over MCP: session reuse across a conversation, explicit discard, TTL on abandoned sessions.
- Draft a lightweight convention doc: "Anonymization Session Tools for MCP" (the standard-setting play) — published as `docs/mcp-anonymization-convention.md`, framed as a proposal with Sci as reference implementation.

### Epic 2.3 — Launch
- Definitive technical post: "Reversible anonymization for LLM round-trips" — the pattern, the edge cases (cascade false-positives, camelCase compounds), the benchmark.
- Publish to blog + HN/lobste.rs; demo GIF of round-trip in Claude Code.

**DoD (Phase 2)**
- [ ] Fresh macOS and fresh Ubuntu machine: install → working `memory_recall` in Claude Code in ≤ 2 commands, ≤ 5 minutes
- [ ] SQLite backend passes the full integration suite; documented as default
- [ ] CI builds/tests on macOS + Linux (x86_64, aarch64)
- [ ] All MCP tools documented with request/response examples
- [ ] Convention doc published and linked from README
- [ ] Launch post published; install path verified by ≥ 3 external users (alpha testers on Linux count)

---

## Phase 3 — Multi-Provider Round-Trip (Months 3–4)

Make "every AI" true. Currently OpenAI/Google are stubs.

### Epic 3.1 — Provider adapters
- OpenAI: chat completions + responses API; streaming de-anonymization (token-boundary-safe replacement in SSE streams).
- Google Gemini: generateContent + streaming.
- Ollama/local: OpenAI-compatible endpoint pass-through (low effort, high demo value).
- Shared adapter interface in `packages/proxy` so a new provider is a bounded, documented task.

### Epic 3.2 — Streaming-safe de-anonymization
- Replacement across chunk boundaries (token split mid-entity) — buffered window strategy with latency budget.
- Property tests: any chunking of a response de-anonymizes to the same final text.

### Epic 3.3 — Proxy hardening
- Lean on lessons from SCI-259/260: supervised restarts, cascade-feedback guardrails per provider.
- Decision point (explicit): evaluate whether TLS-terminating proxy remains a first-class path or becomes "advanced mode," with MCP tools as the recommended surface. Document the decision.

**DoD (Phase 3)**
- [ ] Same prompt round-trips correctly through Claude, GPT, Gemini, and an Ollama model — single shared identity session
- [ ] Streaming responses de-anonymize correctly; property test green over randomized chunkings
- [ ] Provider transcript inspection (raw logs) shows zero real entities outbound for all providers on the edge-case corpus
- [ ] Adapter interface documented; "add a provider" guide exists
- [ ] Proxy soak: 7 days across providers, zero crashes, false-positive cascade rate below the SCI-260 threshold
- [ ] TLS-proxy vs MCP-first decision recorded in `docs/` (ADR)

---

## Phase 4 — The Killer Demo (Month 5)

### Epic 4.1 — Cross-provider identity & memory demo
- Scripted, reproducible demo: one user, one local memory, three providers. Ask Claude something personal → switch to GPT → it still "knows you" → show the provider-side transcripts fully pseudonymous.
- Video (≤ 3 min) + written walkthrough; every step reproducible from a public repo.

### Epic 4.2 — macOS app as the consumer skin
- App's role re-scoped: onboarding, status, session/identity inspection UI on top of the MCP server (not a parallel implementation).
- Single sync adapter shipped (iCloud file-based per strategy; others deleted from the tree).

**DoD (Phase 4)**
- [ ] Demo reproducible from README by an outsider with no help
- [ ] Video published; demo featured on site (dancingbits.ai or project site)
- [ ] Provider-side transcripts in demo verified pseudonymous (automated check, not eyeball)
- [ ] macOS app consumes the same MCP/core path as CLI users (no forked logic)
- [ ] Unused sync adapter stubs removed; one adapter has integration tests

---

## Phase 5 — Memory Consolidation v1 (Month 6)

Only now — gated on the wedge having users — finish the stubbed retention layer.

### Epic 5.1 — Consolidation pipeline
- Implement decay (the existing formula in `decay.ts` finished + tested) and promotion (episodic → semantic → identity) — scope driven by ranked alpha-user recall complaints, not speculative design.
- Nightly/idle consolidation job; runs locally, observable (`memory_status` reports last run, counts).

### Epic 5.2 — Recall quality loop
- Recall-quality eval set built from real (consented) alpha usage patterns.
- Before/after metrics for consolidation on that eval set.

**DoD (Phase 5)**
- [ ] Decay + promotion implemented, unit + integration tested; no stubbed code paths in `consolidator.ts`/`decay.ts`
- [ ] Consolidation runs unattended for 14 days on alpha machines without data loss (audit-table verified)
- [ ] Recall eval shows measurable improvement (target set when eval is built; regression = release blocker)
- [ ] `memory_status` exposes consolidation health
- [ ] ≥ 3 alpha users confirm a previously-reported recall complaint is resolved

---

## 4. Cross-cutting requirements

- **Privacy guarantee invariant** (all phases): no real entity ever leaves the machine in any provider-bound payload; token maps never persisted to provider-visible storage. Every phase's CI includes the edge-case corpus leak check.
- **Honest docs**: every release notes known weaknesses (lexicon NER ceiling, provider coverage) — credibility is a feature.
- **Solo-maintainer budget**: each epic must be shippable independently; no epic blocks on another phase's epic except as ordered above.

## 5. Risks & mitigations (tracked)

| Risk | Phase exposed | Mitigation |
|------|--------------|------------|
| Lexicon NER quality ceiling | 1, 3 | Public benchmark makes the ceiling visible; hybrid on-device transformer NER is the planned v2 (post-Phase 5) |
| Providers ship native privacy modes | all | Messaging: architectural ("never had it") vs contractual ("promised to delete it") |
| Streaming de-anonymization latency | 3 | Latency budget in DoD; fall back to non-streaming if budget blown |
| Maintainer bandwidth | all | Phase 1 extraction is the contributor-attraction play; cut scope by dropping epics, never by weakening DoD |

## 6. Success criteria (program level, end of Month 6)

- sci-anonymizer embedded by ≥ 1 external project, ≥ 500 GitHub stars combined
- ≥ 100 active MCP installs (telemetry-free proxy for this: release download counts)
- Tri-provider round-trip demo published and reproduced externally
- Zero known privacy-guarantee violations across all releases
