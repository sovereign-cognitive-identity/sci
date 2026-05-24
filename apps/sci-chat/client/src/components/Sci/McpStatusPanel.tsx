/**
 * McpStatusPanel — compact, collapsible list of MCP servers and their
 * tool counts, derived from the most recent intercepted audit turn.
 *
 * Mounts inside the inspector's "Turns" tab, above the RecallPreview.
 * Data comes from `GET /sci/mcp_status`, polled every 5 s.
 */

import { useState } from 'react';
import { useMcpStatus } from './hooks';

interface Props {
  enabled: boolean;
}

export default function McpStatusPanel({ enabled }: Props) {
  const { data } = useMcpStatus(enabled);
  const [open, setOpen]   = useState(true);

  if (!data || data.servers.length === 0) return null;

  const asOf = data.asOf ? new Date(data.asOf).toLocaleTimeString() : null;

  return (
    <div className="flex-shrink-0 border-b border-border-medium">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="
          flex w-full items-center justify-between
          px-3 py-1.5
          text-[10px] font-medium text-text-secondary
          hover:bg-surface-secondary hover:text-text-primary
          transition-colors
        "
        aria-expanded={open}
        aria-label="Toggle MCP server list"
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden>🔌</span>
          MCP ({data.servers.length} server{data.servers.length !== 1 ? 's' : ''})
        </span>
        <span aria-hidden className="text-[8px]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-2 pt-1 space-y-0.5">
          {data.servers.map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-[10px]">
              <span
                aria-hidden
                className={s.toolCount > 0 ? 'text-emerald-400' : 'text-amber-400'}
                title={s.toolCount > 0 ? 'Active' : 'No tools registered'}
              >
                ●
              </span>
              <span className="font-mono text-text-primary truncate">
                {s.name === '_builtin' ? '(built-in)' : s.name}
              </span>
              <span className="ml-auto flex-shrink-0 text-text-secondary">
                {s.toolCount} tool{s.toolCount !== 1 ? 's' : ''}
              </span>
            </div>
          ))}
          {asOf && (
            <p className="mt-1 text-[9px] text-text-secondary opacity-60">
              as of {asOf}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
