/**
 * Per-turn card in the flight-recorder inspector. Collapsed by default;
 * click expands to show all six artifacts (user_text, request_body,
 * response_raw, assistant_text, token mappings, recall_injected).
 *
 * SCI-54: adds inline diff highlighting (masked spans rendered as
 * struck-through original → coloured token), per-turn JSON export,
 * and propagates the search query from InspectorPanel to filter
 * the summary row.
 */

import { useState } from 'react';

import { useAuditTurn } from './hooks';
import type { AuditTurn, AuditTurnDetail, TokenMapping } from './types';

interface Props {
  turn: AuditTurn;
  /** Highlight / hide based on this query; empty string = always show. */
  searchQuery: string;
}

// ── Diff highlighting ─────────────────────────────────────────────────────────
//
// Given the original user text and the token-mapping table, split the text
// into runs: plain text and masked spans. Each masked span knows both the
// original word and the replacement token so we can render them inline.

interface PlainRun  { kind: 'plain';  text: string }
interface MaskedRun { kind: 'masked'; original: string; token: string }
type Run = PlainRun | MaskedRun;

function buildDiffRuns(text: string, mappings: TokenMapping[]): Run[] {
  if (mappings.length === 0) return [{ kind: 'plain', text }];

  // Sort longest-original-first so "Casey Zandbergen" replaces before "Casey".
  const sorted = [...mappings].sort((a, b) => b.original.length - a.original.length);

  // Build a single regex that matches any of the originals (word-boundary aware).
  const pattern = sorted
    .map((m) => m.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(?<![\\w@/])(${pattern})(?![\\w])`, 'gi');

  const runs: Run[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      runs.push({ kind: 'plain', text: text.slice(cursor, match.index) });
    }
    const original = match[0];
    // Find the token for this original (case-insensitive).
    const mapping = sorted.find(
      (m) => m.original.toLowerCase() === original.toLowerCase(),
    );
    runs.push({
      kind:     'masked',
      original,
      token: mapping?.token ?? original,
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    runs.push({ kind: 'plain', text: text.slice(cursor) });
  }

  return runs;
}

function DiffText({ text, mappings }: { text: string; mappings: TokenMapping[] }) {
  const runs = buildDiffRuns(text, mappings);
  return (
    <p className="whitespace-pre-wrap break-words leading-relaxed">
      {runs.map((run, i) => {
        if (run.kind === 'plain') {
          return <span key={i}>{run.text}</span>;
        }
        return (
          <span
            key={i}
            title={`masked as ${run.token}`}
            className="inline-flex flex-wrap items-baseline gap-0.5"
          >
            <span className="rounded bg-red-500/15 px-0.5 text-red-400">{run.original}</span>
            <span className="rounded bg-green-500/15 px-0.5 font-mono text-[10px] text-green-400">
              {run.token}
            </span>
          </span>
        );
      })}
    </p>
  );
}

// ── Pretty-print JSON ───────────────────────────────────────────────────────────

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ── JSON export ───────────────────────────────────────────────────────────────

function exportTurnJson(detail: AuditTurnDetail) {
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sci-turn-${detail.turn.id.slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Search match helper ───────────────────────────────────────────────────────

function turnMatchesQuery(turn: AuditTurn, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    turn.host.toLowerCase().includes(q) ||
    (turn.model?.toLowerCase().includes(q) ?? false) ||
    (turn.userText?.toLowerCase().includes(q) ?? false) ||
    (turn.assistantText?.toLowerCase().includes(q) ?? false)
  );
}

// ── TurnCard ──────────────────────────────────────────────────────────────────

export default function TurnCard({ turn, searchQuery }: Props) {
  const [expanded, setExpanded] = useState(false);
  const detail = useAuditTurn(expanded ? turn.id : null);

  if (!turnMatchesQuery(turn, searchQuery)) return null;

  const statusOk    = turn.status != null && turn.status >= 200 && turn.status < 300;
  const statusLabel = turn.status != null ? String(turn.status) : 'pending';
  const ts          = new Date(turn.createdAt);
  const timeStr     = ts.toLocaleTimeString(undefined, {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="mb-2 rounded-md border border-border-medium bg-surface-secondary text-xs text-text-primary">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-tertiary"
        aria-expanded={expanded}
      >
        <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
          <div className="flex items-center gap-2 truncate">
            <span className="font-mono text-text-secondary">{timeStr}</span>
            <span className="truncate">{turn.host}</span>
          </div>
          <div className="flex items-center gap-3 text-text-secondary">
            {turn.model && <span className="truncate">{turn.model}</span>}
            <span className="whitespace-nowrap">🔒 {turn.maskedCount}</span>
            {turn.latencyMs != null && (
              <span className="whitespace-nowrap">⚡ {turn.latencyMs}&thinsp;ms</span>
            )}
            {/* Prompt-cache indicators */}
            {turn.cacheReadTokens != null && turn.cacheReadTokens > 0 && (
              <span
                className="whitespace-nowrap text-emerald-500"
                title={`Cache hit: ${turn.cacheReadTokens.toLocaleString()} tokens read from cache (~90% discount)`}
              >
                🎯 {(turn.cacheReadTokens / 1000).toFixed(1)}k
              </span>
            )}
            {turn.cacheCreationTokens != null && turn.cacheCreationTokens > 0 && turn.cacheReadTokens === 0 && (
              <span
                className="whitespace-nowrap text-amber-500"
                title={`Cache write: ${turn.cacheCreationTokens.toLocaleString()} tokens written to cache`}
              >
                📝 {(turn.cacheCreationTokens / 1000).toFixed(1)}k
              </span>
            )}
            <span
              className={`whitespace-nowrap font-mono ${
                statusOk ? 'text-green-500' : 'text-red-500'
              }`}
            >
              {statusLabel}
            </span>
          </div>
        </div>
        <span aria-hidden className="text-text-secondary">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border-medium p-3 space-y-3">
          {detail.isLoading && (
            <p className="text-text-secondary">Loading turn detail…</p>
          )}
          {detail.error != null && (
            <p className="text-red-500">Failed to load turn: {String(detail.error)}</p>
          )}
          {detail.data && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono text-text-secondary">{turn.id}</span>
                <button
                  type="button"
                  onClick={() => exportTurnJson(detail.data as AuditTurnDetail)}
                  title="Export turn as JSON"
                  className="
                    rounded border border-border-medium px-2 py-0.5
                    text-[10px] text-text-secondary
                    hover:bg-surface-tertiary hover:text-text-primary
                  "
                >
                  ↓ JSON
                </button>
              </div>

              <Section title="You said (original)">
                {detail.data.mappings.length > 0 ? (
                  <DiffText
                    text={detail.data.turn.userText ?? '—'}
                    mappings={detail.data.mappings}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words">
                    {detail.data.turn.userText || '—'}
                  </pre>
                )}
              </Section>

              <Section title="Sci answered (deanonymized)">
                <pre className="whitespace-pre-wrap break-words">
                  {detail.data.turn.assistantText || '—'}
                </pre>
              </Section>

              <Section title={`Token mappings (${detail.data.mappings.length})`}>
                {detail.data.mappings.length === 0 ? (
                  <p className="text-text-secondary">No entities masked.</p>
                ) : (
                  <table className="w-full text-left">
                    <thead className="text-text-secondary">
                      <tr>
                        <th className="pb-1 pr-2">Token</th>
                        <th className="pb-1 pr-2">Original</th>
                        <th className="pb-1">Kind</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.mappings.map((m) => (
                        <tr key={m.id}>
                          <td className="pr-2 font-mono text-green-400">{m.token}</td>
                          <td className="pr-2 break-all text-red-400">{m.original}</td>
                          <td className="text-text-secondary">{m.entityKind}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <CollapsibleSection title="Anonymized request (sent upstream)">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {detail.data.turn.requestBody ? prettyJson(detail.data.turn.requestBody) : '—'}
                </pre>
              </CollapsibleSection>

              {detail.data.turn.responseRaw && (
                <CollapsibleSection title="Raw upstream response (pre-deanon)">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                    {prettyJson(detail.data.turn.responseRaw)}
                  </pre>
                </CollapsibleSection>
              )}

              {detail.data.turn.recallInjected && (
                <CollapsibleSection title="Memory recall injected">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                    {detail.data.turn.recallInjected}
                  </pre>
                </CollapsibleSection>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 font-semibold text-text-secondary">{title}</h4>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="
          mb-1 flex w-full items-center gap-1 text-left font-semibold
          text-text-secondary hover:text-text-primary
        "
        aria-expanded={open}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}
