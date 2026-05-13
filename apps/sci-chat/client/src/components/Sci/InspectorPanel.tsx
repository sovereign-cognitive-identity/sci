/**
 * Flight-recorder inspector. Fixed-position right drawer + floating
 * toggle button. Mounted at the app root so it overlays any route.
 *
 * Persists open/closed + drawer width in localStorage. Subscribes to
 * `/sci/events` while open; invalidates the audit_turns query on
 * `flow_completed` so new turns appear live.
 *
 * SCI-54: search/filter bar over turn list; "Export all" JSON button.
 * Memory graph tab: force-directed graph of all memories.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInspectorControls } from './InspectorContext';

import MemoryGraph from './MemoryGraph';
import ProfileSelector from './ProfileSelector';
import ProjectSelector from './ProjectSelector';
import RecallPreview from './RecallPreview';
import { useActiveProfile, useAuditEvents, useAuditTurns, useHelperStatus } from './hooks';
import TurnCard from './TurnCard';
import type { AuditTurn, AuditTurnDetail } from './types';
import { getAuditTurn } from './api';

const LS_OPEN_KEY  = 'sci.inspector.open';
const LS_WIDTH_KEY = 'sci.inspector.width';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH     = 320;
const MAX_WIDTH     = 800;

type Tab = 'turns' | 'graph';

function readBoolLs(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* SSR / private mode */ }
  return fallback;
}

function readNumberLs(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    const n = v == null ? NaN : Number(v);
    if (Number.isFinite(n)) return n;
  } catch { /* SSR / private mode */ }
  return fallback;
}

// ── Export all turns as JSON ──────────────────────────────────────────────────

async function exportAllTurns(turns: AuditTurn[]) {
  const details: AuditTurnDetail[] = await Promise.all(
    turns.map((t) => getAuditTurn(t.id)),
  );
  const blob = new Blob([JSON.stringify(details, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sci-turns-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InspectorPanel() {
  const { open, width, setOpen, setWidth } = useInspectorControls();
  const [tab,   setTab]   = useState<Tab>('turns');
  const [search, setSearch]   = useState('');
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const active  = useActiveProfile(open);
  const profile = active.data?.name;
  const turns   = useAuditTurns(50, profile);
  const status  = useHelperStatus(open);
  useAuditEvents(open, turns.refetch);

  const visibleCount = useMemo(() => {
    if (!turns.data || !search) return turns.data?.length ?? 0;
    const q = search.toLowerCase();
    return turns.data.filter((t) =>
      t.host.toLowerCase().includes(q) ||
      (t.model?.toLowerCase().includes(q) ?? false) ||
      (t.userText?.toLowerCase().includes(q) ?? false) ||
      (t.assistantText?.toLowerCase().includes(q) ?? false),
    ).length;
  }, [turns.data, search]);

  const handleExportAll = async () => {
    if (!turns.data || turns.data.length === 0) return;
    setExporting(true);
    try { await exportAllTurns(turns.data); }
    finally { setExporting(false); }
  };

  return (
    <>
      <Toggle open={open} onToggle={() => setOpen((x) => !x)} />
      {open && (
        <aside
          className="
            fixed right-0 top-0 z-40 flex h-full
            border-l border-border-medium bg-surface-primary shadow-xl
          "
          style={{ width }}
          aria-label="Sci inspector"
        >
          <Resizer onResize={(delta) => {
            setWidth((w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w - delta)));
          }} />

          <div className="flex h-full flex-1 flex-col overflow-hidden">
            {/* Header */}
            <Header
              status={status.data}
              onClose={() => setOpen(false)}
              enabled={open}
            />

            {/* Tab bar */}
            <div className="flex flex-shrink-0 border-b border-border-medium">
              {(['turns', 'graph'] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`
                    flex-1 py-1.5 text-xs font-medium transition-colors
                    ${tab === t
                      ? 'border-b-2 border-indigo-500 text-text-primary'
                      : 'text-text-secondary hover:text-text-primary'
                    }
                  `}
                >
                  {t === 'turns' ? '✈️ Turns' : '🧠 Memory'}
                </button>
              ))}
            </div>

            {/* ── Turns tab ── */}
            {tab === 'turns' && (
              <>
                {/* Search bar + export */}
                <div className="flex-shrink-0 border-b border-border-medium px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <span
                        aria-hidden
                        className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary select-none"
                      >
                        🔍
                      </span>
                      <input
                        ref={searchRef}
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter by host, model, or text…"
                        aria-label="Filter turns"
                        className="
                          w-full rounded-md border border-border-medium bg-surface-secondary
                          py-1 pl-7 pr-3 text-xs text-text-primary placeholder-text-secondary
                          focus:outline-none focus:ring-1 focus:ring-blue-500
                        "
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={() => setSearch('')}
                          aria-label="Clear search"
                          className="
                            absolute right-2 top-1/2 -translate-y-1/2
                            text-text-secondary hover:text-text-primary
                          "
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {turns.data && turns.data.length > 0 && (
                      <button
                        type="button"
                        onClick={handleExportAll}
                        disabled={exporting}
                        title="Export all visible turns as JSON"
                        className="
                          flex-shrink-0 rounded border border-border-medium px-2 py-1
                          text-[10px] text-text-secondary
                          hover:bg-surface-secondary hover:text-text-primary
                          disabled:opacity-40
                        "
                      >
                        {exporting ? '…' : '↓ All'}
                      </button>
                    )}
                  </div>
                  {search && turns.data && (
                    <p className="mt-1 text-[10px] text-text-secondary">
                      {visibleCount} of {turns.data.length} turns match
                    </p>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto px-3 pb-4 pt-2">
                  <RecallPreview enabled={open} />
                  {turns.isLoading && (
                    <p className="text-sm text-text-secondary">Loading turns…</p>
                  )}
                  {turns.error && (
                    <p className="text-sm text-red-500">
                      Sci helper unreachable at{' '}
                      <code>127.0.0.1:3002</code>.
                      Is sci-helper running? ({String(turns.error)})
                    </p>
                  )}
                  {turns.data && turns.data.length === 0 && (
                    <p className="text-sm text-text-secondary">
                      No turns yet for profile{' '}
                      <span className="font-mono">{profile ?? 'work'}</span>.
                      {' '}Send a chat to start the flight recorder.
                    </p>
                  )}
                  {turns.data && turns.data.length > 0 && search && visibleCount === 0 && (
                    <p className="text-sm text-text-secondary">
                      No turns match{' '}
                      <span className="font-mono">"{search}"</span>.
                    </p>
                  )}
                  {turns.data?.map((t) => (
                    <TurnCard key={t.id} turn={t} searchQuery={search} />
                  ))}
                </div>
              </>
            )}

            {/* ── Memory graph tab ── */}
            {tab === 'graph' && (
              <MemoryGraph profile={profile} enabled={open && tab === 'graph'} />
            )}
          </div>
        </aside>
      )}
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label="Open Sci inspector"
      title="Open Sci inspector"
      className="
        fixed right-3 top-3 z-50 flex h-9 items-center gap-1.5 rounded-full
        border border-border-medium bg-surface-primary px-3
        text-xs font-medium text-text-primary shadow-md
        hover:bg-surface-secondary
      "
    >
      <span aria-hidden>🔒</span>
      Sci
    </button>
  );
}

function Header({
  status,
  onClose,
  enabled,
}: {
  status:  import('./types').HelperStatus | undefined;
  onClose: () => void;
  enabled: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 flex-col border-b border-border-medium">
      {/* Row 1: title + close */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-sm font-semibold text-text-primary">Sci Inspector</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded p-1 text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
        >
          ✕
        </button>
      </div>

      {/* Row 2: stats */}
      <div className="px-3 pb-2">
        <span className="text-[11px] text-text-secondary tabular-nums">
          {status
            ? `v${status.version} · ${status.stats.auditTurns} turns · ${status.stats.episodic + status.stats.semantic + status.stats.identity} memories`
            : 'Connecting…'
          }
        </span>
      </div>

      {/* Row 3: context controls toolbar */}
      <div className="flex items-center gap-2 border-t border-border-medium bg-surface-secondary/40 px-3 py-1.5">
        <ProjectSelector enabled={enabled} />
        <div className="flex-1" />
        <ProfileSelector enabled={enabled} />
      </div>
    </div>
  );
}

function Resizer({ onResize }: { onResize: (deltaX: number) => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;
    const onMove = (ev: MouseEvent) => { onResize(ev.clientX - lastX); lastX = ev.clientX; };
    const onUp   = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-border-medium"
    />
  );
}
