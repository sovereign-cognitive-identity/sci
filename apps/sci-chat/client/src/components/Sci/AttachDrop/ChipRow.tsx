/**
 * Chip row rendered as a fixed-position bar pinned to the bottom of
 * the viewport, positioned above the chat input. We render via a
 * portal-style absolute position so we don't have to touch
 * LibreChat's ChatForm tree.
 *
 * Display logic:
 *   - 0 chips: render nothing (component is mounted but invisible).
 *   - 1+ chips: render a horizontally-scrollable row of chips
 *     plus a summary line ("Attached: 3 files, ~4.2k tokens")
 *     and a "keep attached for thread" toggle.
 *
 * The bar lives outside the form so it doesn't accidentally re-
 * trigger form layout, and uses `pointer-events-auto` so chip
 * removal actually fires.
 */

import { memo } from 'react';

import type { AttachedFile } from './types';
import {
  formatTokenCount,
  sumTokens,
  tokenWarnLevel,
} from './estimate';
import type { TokenWarnLevel } from './estimate';

interface ChipRowProps {
  files: AttachedFile[];
  pinned: boolean;
  onRemove: (id: string) => void;
  onTogglePinned: () => void;
  onClearAll: () => void;
}

const WARN_COLORS: Record<TokenWarnLevel, string> = {
  green:  'text-text-secondary',
  yellow: 'text-amber-500',
  red:    'text-red-500',
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const ChipRow = memo(function ChipRow({
  files,
  pinned,
  onRemove,
  onTogglePinned,
  onClearAll,
}: ChipRowProps) {
  if (files.length === 0) return null;

  const total = sumTokens(files);
  const level = tokenWarnLevel(total);

  return (
    <div
      className="
        pointer-events-auto fixed bottom-[88px] left-1/2 z-30 -translate-x-1/2
        flex w-[min(100%-2rem,56rem)] flex-col gap-1 rounded-xl
        border border-border-medium bg-surface-primary/95 px-3 py-2
        shadow-lg backdrop-blur-sm
      "
      role="region"
      aria-label="Attached files for next message"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-text-primary">
            Attached: {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <span className={`text-xs ${WARN_COLORS[level]}`}>
            ~{formatTokenCount(total)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary"
            title="Keep these attached after sending"
          >
            <input
              type="checkbox"
              checked={pinned}
              onChange={onTogglePinned}
              className="h-3 w-3 accent-blue-500"
            />
            keep for thread
          </label>
          <button
            type="button"
            onClick={onClearAll}
            className="text-[11px] text-text-secondary hover:text-text-primary"
            aria-label="Clear all attached files"
          >
            clear
          </button>
        </div>
      </div>
      <div className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1">
        {files.map((file) => (
          <Chip key={file.id} file={file} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
});

interface ChipProps {
  file: AttachedFile;
  onRemove: (id: string) => void;
}

function Chip({ file, onRemove }: ChipProps) {
  return (
    <div
      className="
        flex shrink-0 items-center gap-1.5 rounded-md border border-border-light
        bg-surface-secondary px-2 py-1 text-xs text-text-primary
      "
      title={`${file.relativePath}\n${formatBytes(file.size)} · ~${formatTokenCount(file.tokenEstimate)}`}
    >
      <span aria-hidden>📄</span>
      <span className="max-w-[14rem] truncate font-mono">{file.name}</span>
      <span className="text-[10px] text-text-secondary">
        {formatBytes(file.size)}
      </span>
      <button
        type="button"
        onClick={() => onRemove(file.id)}
        className="ml-0.5 text-text-secondary hover:text-text-primary"
        aria-label={`Remove ${file.name}`}
      >
        ✕
      </button>
    </div>
  );
}

export default ChipRow;
