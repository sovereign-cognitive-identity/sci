/**
 * SCI-166c — recursive row component for the FolderPicker tree.
 *
 * Renders one node (file or directory). Directories are expandable
 * and recurse into their children. Each row has:
 *
 *   [▸ / ▾]   indent for nesting depth
 *   [☐ / ▣ / ☑] checkbox (tri-state for dirs)
 *   <name>    bold for dirs, normal for files
 *   <size>     bytes badge on file leaves
 *   <ignored>  greyed-out, optional "ignored" chip
 *   <binary>   greyed-out, "binary" chip on binary leaves
 *
 * Selection model:
 *
 *   The picker maintains a `Set<string>` of selected file paths
 *   (leaves only). Directories don't go into the set — their state
 *   is *derived* from their descendants:
 *
 *     - none-selected   → empty checkbox
 *     - all-selected    → filled checkbox
 *     - some-selected   → indeterminate checkbox
 *
 *   Toggling a directory cascades: selects/deselects all selectable
 *   descendants (non-binary, non-ignored unless showIgnored).
 *
 * The component is intentionally dumb — it receives selection state
 * and a toggle callback. The smarts (cascade, derive-state, attach)
 * live in the parent FolderPicker.
 */

import { memo, useCallback, useState } from 'react';
import type { PickerNode } from './types';

/** Derived checkbox state for a node. */
export type CheckState = 'unchecked' | 'checked' | 'indeterminate';

interface TreeNodeProps {
  node: PickerNode;
  depth: number;
  /** Selected file path set — leaves only. */
  selected: Set<string>;
  /** True when ignored files should be visible AND interactable. */
  showIgnored: boolean;
  /**
   * Toggle a single file leaf. Idempotent — the parent computes the
   * next state and passes the resulting Set back via setSelected.
   */
  onToggleFile: (path: string) => void;
  /**
   * Toggle a directory — cascade select/deselect of all selectable
   * descendants. `nextChecked` is the target state computed from the
   * current derived state (indeterminate or unchecked → checked;
   * checked → unchecked).
   */
  onToggleDir: (node: PickerNode, nextChecked: boolean) => void;
}

/**
 * Compute checkbox state for a directory given the selected-set and
 * the descendant file paths. Returns 'unchecked' if no descendants
 * are selectable (e.g. all binary / all ignored hidden).
 */
function computeDirState(
  node:        PickerNode,
  selected:    Set<string>,
  showIgnored: boolean,
): CheckState {
  let total      = 0;
  let count      = 0;
  const visit = (n: PickerNode) => {
    if (n.type === 'file') {
      if (n.binary) return;
      if (n.ignored && !showIgnored) return;
      total++;
      if (selected.has(n.path)) count++;
    } else if (n.children) {
      for (const c of n.children) visit(c);
    }
  };
  if (node.children) {
    for (const c of node.children) visit(c);
  }
  if (total === 0) return 'unchecked';
  if (count === 0) return 'unchecked';
  if (count === total) return 'checked';
  return 'indeterminate';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const INDENT_PX = 16;

function TreeNodeImpl({
  node,
  depth,
  selected,
  showIgnored,
  onToggleFile,
  onToggleDir,
}: TreeNodeProps) {
  // Dirs default to expanded at depth 0..1, collapsed deeper. The
  // user can toggle, but a wall of expanded sub-sub-dirs is hostile
  // for first impression.
  const [expanded, setExpanded] = useState(depth < 2);

  const isDir = node.type === 'dir';
  const isHiddenIgnored = node.ignored && !showIgnored;

  // Hidden ignored entries don't render at all — saves the user from
  // a wall of `node_modules` even seeing them. The toggle reveals.
  if (isHiddenIgnored) return null;

  const state: CheckState = isDir
    ? computeDirState(node, selected, showIgnored)
    : selected.has(node.path)
      ? 'checked'
      : 'unchecked';

  const onCheckboxClick = useCallback(() => {
    if (isDir) {
      onToggleDir(node, state !== 'checked');
    } else {
      onToggleFile(node.path);
    }
  }, [isDir, node, onToggleDir, onToggleFile, state]);

  const onRowClick = useCallback(() => {
    if (isDir) setExpanded((e) => !e);
  }, [isDir]);

  const disabled = !!node.binary;
  const muted    = disabled || node.ignored;

  return (
    <div
      role="treeitem"
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={state === 'checked'}
      className="select-none"
    >
      <div
        className={`flex items-center gap-1 py-0.5 rounded hover:bg-surface-tertiary cursor-pointer ${muted ? 'opacity-50' : ''}`}
        style={{ paddingLeft: depth * INDENT_PX + 4 }}
        onClick={onRowClick}
      >
        {/* Expand chevron — fixed width so labels align. */}
        <span className="inline-block w-4 text-xs text-text-secondary">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>

        {/* Checkbox. We render a native input for accessibility +
            indeterminate support; styling is plain to match LibreChat's
            existing checkbox vibe. */}
        <input
          type="checkbox"
          checked={state === 'checked'}
          ref={(el) => {
            if (el) el.indeterminate = state === 'indeterminate';
          }}
          disabled={disabled}
          onChange={onCheckboxClick}
          onClick={(e) => e.stopPropagation()}
          aria-label={`${isDir ? 'directory' : 'file'} ${node.name}`}
          className="h-3.5 w-3.5"
        />

        {/* Name. Dir = bold, file = normal. Truncate gracefully on long names. */}
        <span className={`flex-1 truncate text-sm ${isDir ? 'font-semibold' : ''}`}>
          {node.name}
        </span>

        {/* Size badge for leaves. */}
        {!isDir && typeof node.size === 'number' && node.size > 0 && (
          <span className="text-xs text-text-secondary tabular-nums">
            {formatSize(node.size)}
          </span>
        )}

        {/* "ignored" chip when we're showing ignored entries. Without
            the chip, the only signal is the muted color, which is
            ambiguous against the "binary" cause. */}
        {node.ignored && showIgnored && (
          <span className="text-[10px] uppercase tracking-wide px-1 rounded bg-surface-tertiary text-text-secondary">
            ignored
          </span>
        )}
        {node.binary && (
          <span className="text-[10px] uppercase tracking-wide px-1 rounded bg-surface-tertiary text-text-secondary">
            binary
          </span>
        )}
      </div>

      {/* Subtree. Only mounted when expanded — saves a meaningful
          amount of render time on big repos. */}
      {isDir && expanded && node.children && node.children.length > 0 && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              showIgnored={showIgnored}
              onToggleFile={onToggleFile}
              onToggleDir={onToggleDir}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized to avoid re-rendering every descendant when an unrelated
 * row toggles. The `selected` Set changes identity on every toggle,
 * but React still bails on equal-by-reference props for nodes
 * whose children don't include the changed path — the parent
 * picker passes the same Set down, and memo's shallow compare
 * skips re-render for unaffected subtrees only if their `selected`
 * prop is also unchanged… which it isn't, since it's the same Set
 * reference.
 *
 * The honest answer: full re-render of the tree on each toggle is
 * fine up to ~10k visible rows. If picker perf becomes a problem
 * on huge repos, the right move is `react-window` virtualization,
 * not finer memo plumbing.
 */
const TreeNode = memo(TreeNodeImpl);
export default TreeNode;
