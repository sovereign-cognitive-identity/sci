/**
 * Flight-recorder inspector. Fixed-position right drawer + floating
 * toggle button. Mounted at the app root so it overlays any route.
 *
 * Persists open/closed + drawer width in localStorage. Subscribes to
 * `/sci/events` while open; invalidates the audit_turns query on
 * `flow_completed` so new turns appear live.
 */

import { useEffect, useState } from 'react';

import ProfileSelector from './ProfileSelector';
import RecallPreview from './RecallPreview';
import { useAuditEvents, useAuditTurns, useHelperStatus } from './hooks';
import TurnCard from './TurnCard';

const LS_OPEN_KEY  = 'sci.inspector.open';
const LS_WIDTH_KEY = 'sci.inspector.width';
const DEFAULT_WIDTH  = 380;
const MIN_WIDTH      = 280;
const MAX_WIDTH      = 720;

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

export default function InspectorPanel() {
  const [open,  setOpen]  = useState(() => readBoolLs(LS_OPEN_KEY, false));
  const [width, setWidth] = useState(() => readNumberLs(LS_WIDTH_KEY, DEFAULT_WIDTH));

  useEffect(() => {
    try { localStorage.setItem(LS_OPEN_KEY, open ? '1' : '0'); }
    catch { /* ignore */ }
  }, [open]);

  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH_KEY, String(width)); }
    catch { /* ignore */ }
  }, [width]);

  // Only fetch + subscribe while the drawer is open. Closes the SSE
  // connection on collapse so we don't hold an open EventSource per tab.
  const turns  = useAuditTurns(50);
  const status = useHelperStatus(open);
  useAuditEvents(open);

  return (
    <>
      <Toggle open={open} onToggle={() => setOpen((x) => !x)} />
      {open && (
        <aside
          className="
            fixed right-0 top-0 z-40 flex h-full
            border-l border-border-medium bg-surface-primary
            shadow-xl
          "
          style={{ width }}
          aria-label="Sci flight recorder"
        >
          <Resizer onResize={(delta) => {
            setWidth((w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w - delta)));
          }} />
          <div className="flex h-full flex-1 flex-col">
            <Header status={status.data} onClose={() => setOpen(false)} enabled={open} />
            <div className="flex-1 overflow-y-auto px-3 pb-4 pt-2">
              <RecallPreview enabled={open} />
              {turns.isLoading && (
                <p className="text-sm text-text-secondary">Loading turns…</p>
              )}
              {turns.error && (
                <p className="text-sm text-red-500">
                  Sci helper unreachable at <code>127.0.0.1:3002</code>.
                  Is sci-helper running? ({String(turns.error)})
                </p>
              )}
              {turns.data && turns.data.length === 0 && (
                <p className="text-sm text-text-secondary">
                  No turns yet. Send a chat to start the flight recorder.
                </p>
              )}
              {turns.data?.map((t) => (
                <TurnCard key={t.id} turn={t} />
              ))}
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function Toggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={open ? 'Close Sci inspector' : 'Open Sci inspector'}
      title={open ? 'Close Sci inspector' : 'Open Sci inspector'}
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
  status: import('./types').HelperStatus | undefined;
  onClose: () => void;
  enabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border-medium px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <div className="text-sm font-semibold text-text-primary">Sci flight recorder</div>
        {status && (
          <div className="text-[11px] text-text-secondary">
            v{status.version} · {status.stats.auditTurns} turns ·{' '}
            {status.stats.episodic} memories
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <ProfileSelector enabled={enabled} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="
            rounded-md px-2 py-1 text-text-secondary
            hover:bg-surface-secondary hover:text-text-primary
          "
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function Resizer({ onResize }: { onResize: (deltaX: number) => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      onResize(ev.clientX - lastX);
      lastX = ev.clientX;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className="
        absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize
        bg-transparent hover:bg-border-medium
      "
    />
  );
}
