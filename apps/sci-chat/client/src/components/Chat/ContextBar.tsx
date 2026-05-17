/**
 * ContextBar — shows context window usage for the active conversation.
 *
 * Reads the most recent sci audit turn to get accurate input token counts,
 * maps the model to its published context window, and renders a compact
 * progress bar + token count in the chat header.
 *
 * Total context = inputTokens (non-cached) + cacheReadTokens (cached portion).
 * Refreshes every 30s and after each flow_completed SSE event.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { listAuditTurns, eventsUrl } from '~/components/Sci/api';
import type { HelperEvent } from '~/components/Sci/types';
import { cn } from '~/utils';

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7':           200_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5':          200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'gpt-4.1':                 1_047_576,
  'gpt-4.1-mini':            1_047_576,
  'gpt-4o':                    128_000,
  'gpt-4':                     128_000,
  'gpt-4-turbo':               128_000,
};

const QK = ['sci', 'context_usage'] as const;

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000)}k`;
}

export default function ContextBar() {
  const qc = useQueryClient();

  const { data: turn } = useQuery({
    queryKey:           QK,
    queryFn:            async () => { const t = await listAuditTurns(1); return t[0] ?? null; },
    staleTime:          30_000,
    refetchInterval:    30_000,
    refetchOnWindowFocus: false,
  });

  // Invalidate immediately on flow_completed so the bar updates right after
  // each AI response without waiting for the 30s poll cycle.
  useEffect(() => {
    let src: EventSource | null = null;
    try {
      src = new EventSource(eventsUrl());
      src.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as HelperEvent;
          if (ev.type === 'flow_completed') {
            qc.invalidateQueries({ queryKey: QK });
          }
        } catch { /* ignore */ }
      };
      src.onerror = () => { /* sci-helper offline — EventSource auto-reconnects */ };
    } catch { /* SSR / no sci-helper */ }
    return () => src?.close();
  }, [qc]);

  if (!turn?.inputTokens) return null;

  // Only show if the turn is recent (within last 20 minutes) to avoid
  // displaying stale context from a previous session.
  const ageMs = Date.now() - new Date(turn.createdAt).getTime();
  if (ageMs > 20 * 60 * 1000) return null;

  const contextWindow = CONTEXT_WINDOWS[turn.model ?? ''] ?? 200_000;
  const used = turn.inputTokens + (turn.cacheReadTokens ?? 0);
  const pct  = Math.min(100, (used / contextWindow) * 100);

  const barCls =
    pct < 60 ? 'bg-emerald-500' :
    pct < 85 ? 'bg-amber-400'   :
               'bg-red-400';

  return (
    <div
      className="flex items-center gap-1.5 text-[10px] tabular-nums text-text-secondary"
      title={`Context: ${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    >
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700', barCls)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span>{fmt(used)}/{fmt(contextWindow)}</span>
      <span className="opacity-60">({Math.round(pct)}%)</span>
    </div>
  );
}
