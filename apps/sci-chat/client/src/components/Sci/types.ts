/**
 * Wire types for the Sci helper admin API at `http://127.0.0.1:3002`.
 *
 * Field names match the helper's serde rename pattern (camelCase).
 * Keep these in sync with `core/crates/sci-memory/src/types.rs` and
 * `apps/sci-mac/SciHelper/src/admin.rs`.
 */

export interface AuditTurn {
  id: string;
  profileId: string | null;
  createdAt: string;
  host: string;
  endpoint: string;
  model: string | null;
  oauthActive: boolean;
  userText: string | null;
  assistantText: string | null;
  requestBody: string | null;
  responseRaw: string | null;
  recallInjected: string | null;
  maskedCount: number;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface TokenMapping {
  id: number;
  turnId: string;
  profileId: string | null;
  token: string;
  original: string;
  entityKind: string;
  direction: 'outbound' | 'inbound';
  createdAt: string;
}

export interface AuditTurnDetail {
  turn: AuditTurn;
  mappings: TokenMapping[];
}

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
}

export interface StorageStats {
  episodic: number;
  semantic: number;
  identity: number;
  embeddings: number;
  auditTurns: number;
  backend: string;
}

export interface HelperStatus {
  version: string;
  uptimeSeconds: number;
  stats: StorageStats;
}

/**
 * `data` payload of an `/sci/events` SSE frame. Discriminated by `type`;
 * mirrors the Rust enum `Event` in `apps/sci-mac/SciHelper/src/events.rs`.
 * We don't try to be exhaustive in TS — only the variants the inspector
 * cares about are typed; the rest pass through as `unknown` and the UI
 * ignores them.
 */
export type HelperEvent =
  | { type: 'flow_started';   host: string; ts: number }
  | { type: 'flow_completed'; host: string; masked: number; ms: number; status: number; ts: number }
  | { type: 'flow_error';     host: string; error: string; ts: number }
  | { type: string;           [k: string]: unknown };
