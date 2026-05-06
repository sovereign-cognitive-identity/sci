# Portable AI Memory Landscape

A map of projects working to move AI memory out of proprietary walled gardens — toward portable, user-owned, hardware-secured "memory passports."

> **Status:** Initial landscape sketch (May 2026). Deep-dive on positioning, overlap, and cooperation follows below.

---

## 1. Universal Standards & Interchange Formats
*Common languages so context from one AI is legible to another.*

| Project | Role | Notes |
|---|---|---|
| **Portable AI Memory (PAM)** | Spec | The "vCard of AI" — vendor-neutral interchange format for user context, preferences, and knowledge. |
| **Model Context Protocol (MCP)** | Protocol | Open standard for agent ↔ tools/data interop; agents can switch apps/providers while retaining memory. |
| **Mem0** | Product | Cross-application "memory passport" layer. Raised $24M. |

## 2. Hardware & Zero-Trust Security
*Cryptographic and CPU-level guarantees for sensitive personal context.*

| Project | Mechanism | Notes |
|---|---|---|
| **MemTrust** | TEEs | Hardware-backed zero-trust; cryptographic guarantees for cross-app sharing even on a compromised host. |
| **Intel × Google (TDX)** | Trust Domain eXtensions | CPU-level isolation for AI workloads. |
| **Kinic AI** | ZKPs | Decentralized architecture; AI proves understanding of preferences without seeing raw data. |

## 3. Decentralized & Local Memory Layers
*Data sovereignty — memory on user infrastructure, not company servers.*

| Project | Approach | Notes |
|---|---|---|
| **Plurality Network** | "AI Context Flow" | Anti-lock-in; long-term memory as a user-controlled asset. |
| **Personal AI** | Edge SLMs | Small Language Models on-device/local network for regulated use. |
| **Persistent AI Memory (Savantskie)** | Env-var portability | Open source; replaces hardcoded paths so memory moves across local/cloud environments. |
| **MemPalace** | Method of loci | Open source; spatial memory technique for decentralized storage. |

## 4. Portable Development Environments
*Carrying your full AI setup with you, securely.*

- **KoboldCpp + VSCodium on encrypted USB-SSD** — VeraCrypt for partition encryption, PortableApps for software management. Plug your "AI brain" into any machine.

---

## How the layers fit together

```
[ Standards: PAM, MCP, Mem0 ]              ← interchange / portability
            │
[ Sovereignty: Plurality, Personal AI,     ← where the data lives
  Savantskie, MemPalace ]
            │
[ Security: MemTrust, TDX, Kinic ]         ← how it's protected
            │
[ Portability: Kobold/VSCodium/USB ]       ← how you carry it
```

Sci sits primarily in layers 1 + 2 (interchange + sovereignty): MCP-native, local Postgres+pgvector, BGE embeddings by default, anonymization proxy on the egress side.

---

## Deep dive: positioning, overlap, cooperation

*This section will be filled in once research returns. See companion notes below.*
