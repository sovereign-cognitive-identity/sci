/**
 * SCI-166c — folder picker modal.
 *
 * Opens when the user drops a folder (or mixed file/folder set with
 * at least one folder). Walks the tree, shows a checkable tree
 * view, then on confirm reads selected file contents through the
 * standard chip-read pipeline and pushes them into the
 * `attachedFilesAtom`.
 *
 * Selection model: see TreeNode.tsx. The picker holds a
 * `Set<string>` of selected leaf paths (relative to the dropped
 * root). Toggling a directory cascades via `cascadeDir` below.
 *
 * Confirm path:
 *   1. Resolve every selected leaf's FileSystemFileEntry to a
 *      File via the entry.file() callback.
 *   2. Hand the File[] to readBatch(), which applies the same
 *      size/binary/encoding rules as the single-file drop path.
 *   3. Push accepted chips into the Recoil atom; toast on
 *      rejected/warned. (Most rejections are caught at walk time
 *      via the binary sniff, but a few only surface on full read
 *      — e.g. a > 5 MB file that wasn't size-checked because we
 *      skipped the slice for ignored entries.)
 *
 * UI: the modal is a self-contained portal-free div with a fixed
 * backdrop + centered card. We don't depend on LibreChat's dialog
 * component to keep this addition zero-touch (and because the
 * Sci sidebar already follows this "build our own surface" pattern).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSetRecoilState } from 'recoil';

import { useToastContext } from '@librechat/client';

import { readBatch } from './reader';
import { sumTokens, formatTokenCount, estimateTokens } from './estimate';
import { attachedFilesAtom } from './store';
import { flattenFiles, walkFolder } from './tree';
import type { PickerNode } from './types';
import type { WalkResult } from './tree';
import TreeNode from './TreeNode';

interface FolderPickerProps {
  /** The directory entry that was dropped. */
  rootEntry: FileSystemDirectoryEntry;
  /** Called when the user confirms or cancels. */
  onClose: () => void;
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Cascade-toggle a directory: collect every selectable descendant
 * leaf, then either union them into the set or remove them.
 *
 * "Selectable" = file, not binary, and either not-ignored or
 * showIgnored is on.
 */
function cascadeDir(
  node:         PickerNode,
  next:         boolean,
  showIgnored:  boolean,
  selected:     Set<string>,
): Set<string> {
  const out = new Set(selected);
  const leaves = flattenFiles(node, showIgnored);
  for (const leaf of leaves) {
    if (next) out.add(leaf.path);
    else      out.delete(leaf.path);
  }
  return out;
}

/**
 * Walk the result tree and resolve a set of paths to their
 * FileSystemFileEntry handles. We carried the entry on each leaf
 * during the walk so this is O(N) over the tree.
 */
function resolveEntries(
  node:     PickerNode,
  selected: Set<string>,
  out:      FileSystemFileEntry[],
): void {
  if (node.type === 'file') {
    if (selected.has(node.path) && node.entry) out.push(node.entry);
    return;
  }
  if (node.children) {
    for (const c of node.children) resolveEntries(c, selected, out);
  }
}

/**
 * Promise wrapper for entry.file() — same as in tree.ts but kept
 * inline here to avoid a circular dep with reader-ish utilities.
 */
function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(file),
      (err) => reject(err),
    );
  });
}

export default function FolderPicker({ rootEntry, onClose }: FolderPickerProps) {
  const [walk, setWalk]         = useState<WalkResult | null>(null);
  const [walkError, setError]   = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showIgnored, setShow]  = useState(false);
  const [confirming, setBusy]   = useState(false);

  const setFiles = useSetRecoilState(attachedFilesAtom);
  const { showToast } = useToastContext();

  // Walk on mount. Disposed via a flag so a fast-unmount doesn't
  // setState on a dead component.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await walkFolder(rootEntry);
        if (!live) return;
        setWalk(result);
        // Pre-select all non-ignored, non-binary files by default —
        // that's the user's most likely intent ("attach this folder").
        // They can deselect anything they don't want before confirm.
        const initial = new Set<string>();
        for (const leaf of flattenFiles(result.root, false)) {
          initial.add(leaf.path);
        }
        setSelected(initial);
      } catch (e) {
        if (!live) return;
        const detail = e instanceof Error ? e.message : String(e);
        setError(`Could not read folder: ${detail}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [rootEntry]);

  // Token estimate is derived from the selection. We DON'T have
  // file contents at this point (walk reads sizes, not content),
  // so we estimate via size / chars-per-token approximation. Same
  // ratio as estimate.ts uses for already-read content; for binary-
  // free text files the bytes/chars distinction is negligible.
  const tokenEstimate = useMemo(() => {
    if (!walk) return 0;
    let bytes = 0;
    const visit = (n: PickerNode) => {
      if (n.type === 'file' && selected.has(n.path)) {
        bytes += n.size ?? 0;
      } else if (n.children) {
        for (const c of n.children) visit(c);
      }
    };
    visit(walk.root);
    // Use estimateTokens with a synthetic content of `bytes` length.
    // (Spaces-as-filler — only the length matters to the heuristic.)
    return estimateTokens(' '.repeat(bytes));
  }, [walk, selected]);

  const onToggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else                next.add(path);
      return next;
    });
  }, []);

  const onToggleDir = useCallback(
    (node: PickerNode, nextChecked: boolean) => {
      setSelected((prev) => cascadeDir(node, nextChecked, showIgnored, prev));
    },
    [showIgnored],
  );

  const onConfirm = useCallback(async () => {
    if (!walk) return;
    if (selected.size === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const entries: FileSystemFileEntry[] = [];
      resolveEntries(walk.root, selected, entries);

      const files: File[] = [];
      const readErrors: string[] = [];
      // Resolve to File handles in parallel. Errors per-entry are
      // collected and reported as one toast at the end.
      const fileResults = await Promise.all(
        entries.map((e) =>
          fileFromEntry(e)
            .then((f) => ({ ok: true as const, file: f }))
            .catch((err): { ok: false; name: string; err: unknown } => ({
              ok: false,
              name: e.name,
              err,
            })),
        ),
      );
      for (const r of fileResults) {
        if (r.ok) files.push(r.file);
        else {
          const detail = r.err instanceof Error ? r.err.message : String(r.err);
          readErrors.push(`${r.name}: ${detail}`);
        }
      }

      // readBatch hands us back chip records ready for the atom.
      // We pass the dropped-folder name as `base` so relativePaths
      // strip the leading folder name, matching the picker's
      // displayed paths.
      const result = await readBatch(files, walk.root.name);

      if (result.accepted.length > 0) {
        setFiles((prev) => [...prev, ...result.accepted]);
      }
      if (result.rejected.length > 0) {
        const names = result.rejected.map((r) => r.name).slice(0, 3).join(', ');
        const more  = result.rejected.length > 3 ? ` (+${result.rejected.length - 3} more)` : '';
        showToast({
          message: `Rejected ${result.rejected.length} ${result.rejected.length === 1 ? 'file' : 'files'}: ${names}${more}`,
          status:  'error',
        });
      }
      if (readErrors.length > 0) {
        showToast({
          message: `Could not read ${readErrors.length} ${readErrors.length === 1 ? 'file' : 'files'}`,
          status:  'error',
        });
      }
      if (result.accepted.length > 0) {
        showToast({
          message: `Attached ${result.accepted.length} ${result.accepted.length === 1 ? 'file' : 'files'} from ${walk.root.name}`,
          status:  'success',
        });
      }
    } finally {
      setBusy(false);
      onClose();
    }
  }, [walk, selected, onClose, setFiles, showToast]);

  // Keyboard: Escape cancels, Enter confirms. Standard modal feel.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onClose();
      } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        void onConfirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onConfirm]);

  const folderName = walk?.root.name ?? rootEntry.name;
  const fileCount  = walk?.totalFiles ?? 0;
  const totalBytes = walk?.totalBytes ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Attach files from ${folderName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface-primary text-text-primary rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col border border-border-light"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-light flex items-baseline gap-2">
          <h2 className="text-base font-semibold truncate">{folderName}</h2>
          {walk && (
            <span className="text-xs text-text-secondary">
              {fileCount} {fileCount === 1 ? 'file' : 'files'} · {bytesHuman(totalBytes)}
              {walk.truncated && ' · truncated'}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto px-2 py-2 font-mono">
          {walkError && (
            <div className="text-sm text-red-500 p-4">{walkError}</div>
          )}
          {!walk && !walkError && (
            <div className="text-sm text-text-secondary p-4">Reading folder…</div>
          )}
          {walk && (
            <div role="tree" aria-label={`Files in ${folderName}`}>
              <TreeNode
                node={walk.root}
                depth={0}
                selected={selected}
                showIgnored={showIgnored}
                onToggleFile={onToggleFile}
                onToggleDir={onToggleDir}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border-light flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={showIgnored}
              onChange={(e) => setShow(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show ignored
          </label>

          <div className="flex-1 text-xs text-text-secondary">
            {selected.size > 0 && (
              <>
                {selected.size} selected · ~{formatTokenCount(tokenEstimate)}
              </>
            )}
          </div>

          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded hover:bg-surface-tertiary"
            onClick={onClose}
            disabled={confirming}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded bg-brand-purple text-white disabled:opacity-50"
            onClick={() => void onConfirm()}
            disabled={confirming || !walk || selected.size === 0}
          >
            {confirming ? 'Attaching…' : `Attach ${selected.size > 0 ? selected.size : ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
