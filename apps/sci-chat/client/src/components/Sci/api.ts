/**
 * Helper admin API client. Hits `http://127.0.0.1:3002` directly from
 * the browser — CORS on the helper allows any origin because the
 * listener is hardcoded to 127.0.0.1.
 *
 * Override via `VITE_SCI_HELPER_URL` if running against a non-default
 * helper port (e.g. for tests).
 */

import type {
  AuditTurn,
  AuditTurnDetail,
  HelperStatus,
  Profile,
  RecallResult,
} from './types';

const HELPER_BASE: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_SCI_HELPER_URL?: string } }).env?.VITE_SCI_HELPER_URL) ||
  'http://127.0.0.1:3002';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HELPER_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Sci helper ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function listAuditTurns(limit = 50, profile?: string): Promise<AuditTurn[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (profile) {
    params.set('profile', profile);
  }
  return getJson<AuditTurn[]>(`/sci/audit_turns?${params}`);
}

export function getAuditTurn(id: string): Promise<AuditTurnDetail> {
  return getJson<AuditTurnDetail>(`/sci/audit_turns/${encodeURIComponent(id)}`);
}

export function getStatus(): Promise<HelperStatus> {
  return getJson<HelperStatus>('/sci/status');
}

export function listProfiles(): Promise<Profile[]> {
  return getJson<Profile[]>('/sci/profiles');
}

/**
 * SCI-157: preview what `inject_memory_context` would surface for a
 * given query string under the requested profile. Read-only — does
 * NOT write to memory or affect future turns. Backed by the helper's
 * `LocalAdapter::recall` which already runs the same scoring as the
 * production injection path.
 */
export function previewRecall(
  query: string,
  profile: string,
  limit = 5,
): Promise<RecallResult[]> {
  const params = new URLSearchParams({
    query,
    profile,
    limit: String(limit),
  });
  return getJson<RecallResult[]>(`/sci/recall?${params}`);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HELPER_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`Sci helper ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export function createProfile(name: string): Promise<Profile> {
  return postJson<Profile>('/sci/profiles', { name });
}

export function getActiveProfile(): Promise<{ name: string }> {
  return getJson<{ name: string }>('/sci/active_profile');
}

export function setActiveProfile(name: string): Promise<{ name: string }> {
  return postJson<{ name: string }>('/sci/active_profile', { name });
}

export interface ActiveProject {
  path: string | null;
}

export function getActiveProject(): Promise<ActiveProject> {
  return getJson<ActiveProject>('/sci/active_project');
}

export function setActiveProject(path: string | null): Promise<ActiveProject> {
  return postJson<ActiveProject>('/sci/active_project', { path });
}

export function eventsUrl(): string {
  return `${HELPER_BASE}/sci/events`;
}
