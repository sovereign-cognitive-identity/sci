/**
 * Per-turn card in the flight-recorder inspector. Collapsed by default;
 * click expands to show all six artifacts (user_text, request_body,
 * response_raw, assistant_text, token mappings, recall_injected).
 */

import { useState } from 'react';

import { useAuditTurn } from './hooks';
import type { AuditTurn } from './types';

interface Props {
  turn: AuditTurn;
}

export default function TurnCard({ turn }: Props) {
  const [expanded, setExpanded] = useState(false);
  const detail = useAuditTurn(expanded ? turn.id : null);

  const statusOk    = turn.status != null && turn.status >= 200 && turn.status < 300;
  const statusLabel = turn.status != null ? String(turn.status) : 'pending';
  const ts          = new Date(turn.createdAt);
  const timeStr     = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div
      className="
        mb-2 rounded-md border border-border-medium bg-surface-secondary
        text-xs text-text-primary
      "
    >
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="
          flex w-full items-center justify-between gap-2 px-3 py-2 text-left
          hover:bg-surface-tertiary
        "
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
          {detail.error && (
            <p className="text-red-500">Failed to load turn: {String(detail.error)}</p>
          )}
          {detail.data && (
            <>
              <Section title="You said (original)">
                <pre className="whitespace-pre-wrap break-words">
                  {detail.data.turn.userText || '—'}
                </pre>
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
                          <td className="pr-2 font-mono">{m.token}</td>
                          <td className="pr-2 break-all">{m.original}</td>
                          <td className="text-text-secondary">{m.entityKind}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <CollapsibleSection title="Anonymized request (sent upstream)">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {detail.data.turn.requestBody || '—'}
                </pre>
              </CollapsibleSection>

              {detail.data.turn.responseRaw && (
                <CollapsibleSection title="Raw upstream response (pre-deanon)">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                    {detail.data.turn.responseRaw}
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
