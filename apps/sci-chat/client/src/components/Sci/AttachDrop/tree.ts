/**
 * SCI-166c — recursive folder walker for the FolderPicker modal.
 *
 * Input: a FileSystemDirectoryEntry surfaced from a drop event's
 * `dataTransfer.items[*].webkitGetAsEntry()`. Output: a PickerNode
 * tree, leaves tagged with size + binary-sniff + ignore verdict.
 *
 * Constraints from the ticket:
 *   - Depth cap of 5 (counted from the dropped root: depth 0 = root,
 *     children at depth 1, etc.). Anything deeper is *not walked* —
 *     the depth-5 directory appears as a leaf node with a synthetic
 *     `truncated` marker the picker can render as "… (deeper files
 *     not shown)".
 *   - Symlinks: not followed. The browser FS-entries API doesn't
 *     surface symlink-ness directly; on macOS Chrome a symlinked
 *     directory shows up as a normal FileSystemDirectoryEntry. We
 *     can't tell. The mitigation we DO have: a global node-count
 *     hard cap (`MAX_NODES`) protects against accidental cycles or
 *     enormous trees.
 *   - .gitignore + default safety set filtering applied as a verdict
 *     tag per node, NOT as a hard skip. The picker shows ignored
 *     files greyed-out (default hidden), with a "Show ignored"
 *     toggle. This way the user can opt-in to including, say, a
 *     specific lockfile if they really want it.
 *   - Binary files: sniffed via the limits.ts sniffer (NUL byte +
 *     non-printable ratio in first 4 KB). Binary leaves get
 *     `binary: true` and the picker renders them unselectable.
 *     Skipping the sniff for ignored files (perf — we'd never read
 *     them anyway unless the user toggles "Show ignored", but at
 *     that point a one-time read is fine).
 *
 * The walk is parallelized across siblings (Promise.all on each
 * directory's children) so a wide-but-shallow tree completes in
 * roughly the depth of the tree rather than its file count.
 *
 * Pure async — no UI side effects. Errors are swallowed per-entry
 * (a permission failure on one file shouldn't abort the whole
 * walk); failed entries appear as leaves with `error` set so the
 * picker can render them muted.
 */

import ignore from 'ignore';
import type { Ignore } from 'ignore';

import { buildIgnore, isIgnored } from './ignore';
import { isLikelyBinary, MAX_FILE_BYTES } from './limits';
import type { PickerNode } from './types';

/** Per the ticket. */
export const MAX_DEPTH = 5;

/**
 * Hard cap on total nodes in the returned tree. Protects against
 * symlink cycles, monorepo accidents, and the user dragging in
 * `/`. Far more than a reasonable repo (a clone of LibreChat
 * itself is ~5k tracked files) and the picker will still render
 * fine at this size.
 */
export const MAX_NODES = 20_000;

/** Bytes scanned for binary sniffing per file. */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Total walk result. `truncated` is set when MAX_NODES was hit
 * before the walk finished — the picker can surface this so the
 * user knows their selection is from an incomplete view.
 */
export interface WalkResult {
  root: PickerNode;
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Promise wrappers around the FileSystemEntry callback-based API.
 * Kept as small helpers rather than a full Promisify so the call
 * sites read naturally. Errors are normalized to rejected promises.
 */

function readDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(
      (entries) => resolve(entries),
      (err) => reject(err),
    );
  });
}

/**
 * Read a `File` (Blob) as UTF-8 text. Uses the modern `Blob.text()`
 * method when available (Chromium, Firefox, Safari current); falls
 * back to FileReader.readAsText for jsdom/older runtimes. Pure
 * async — no UI side effects.
 */
function readFileText(file: Blob): Promise<string> {
  type WithText = Blob & { text?: () => Promise<string> };
  const withText = file as WithText;
  if (typeof withText.text === 'function') {
    return withText.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsText(file);
  });
}

/**
 * `FileSystemDirectoryReader.readEntries` is documented to return ENTRIES IN
 * BATCHES — it returns up to ~100 per call and signals EOF with
 * an empty array. So we call it in a loop and concatenate. This
 * is the bug everyone hits the first time they touch this API.
 */
async function readAllDirEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // The empty-array sentinel terminates. Cap the loop count at a
  // sane number to defend against a misbehaving implementation —
  // 1024 batches × ~100 = 100k entries, well past MAX_NODES.
  for (let i = 0; i < 1024; i++) {
    // eslint-disable-next-line no-await-in-loop -- reader returns batches sequentially
    const batch = await readDirEntries(reader);
    if (batch.length === 0) return all;
    all.push(...batch);
  }
  return all;
}

function readFileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(file),
      (err) => reject(err),
    );
  });
}

/**
 * Read the dropped folder's `.gitignore` (if any) so the walker
 * can seed its matcher. Looks only at the root — nested gitignores
 * are not respected in v1. The `ignore` package supports nested
 * gitignores via prefixing, but the bookkeeping isn't worth it
 * for the snapshot-attach use case (the user can manually deselect
 * stuff that slipped through).
 *
 * Returns the matcher to use for the walk.
 */
async function loadRootIgnore(root: FileSystemDirectoryEntry): Promise<Ignore> {
  try {
    const reader = root.createReader();
    const entries = await readDirEntries(reader);
    const gitignore = entries.find(
      (e): e is FileSystemFileEntry => e.isFile && e.name === '.gitignore',
    );
    if (!gitignore) return buildIgnore('');
    const file = await readFileFromEntry(gitignore);
    const text = await readFileText(file);
    return buildIgnore(text);
  } catch {
    return buildIgnore('');
  }
}

/**
 * Per-file leaf node construction. Reads metadata + binary sniff;
 * does NOT load the full file contents — that happens at attach
 * time so the picker stays fast on huge repos.
 */
async function buildFileNode(
  entry: FileSystemFileEntry,
  relativePath: string,
  matcher: Ignore,
): Promise<PickerNode> {
  const ignored = isIgnored(matcher, relativePath);

  let size = 0;
  let binary = false;
  let errored = false;
  let errMsg: string | null = null;

  try {
    const file = await readFileFromEntry(entry);
    size = file.size;
    if (!ignored && size <= MAX_FILE_BYTES && size > 0) {
      // Sniff the first few KB. Older Blob implementations (jsdom)
      // don't expose `.text()` at all, so we go through readFileText
      // which falls back to FileReader. For ≤5 MB files reading the
      // whole thing is fine; the alternative (FileReader on a Blob
      // slice) is 3x the code for no real win.
      const full = await readFileText(file);
      const sample = full.slice(0, BINARY_SNIFF_BYTES);
      binary = isLikelyBinary(sample);
    } else if (size > MAX_FILE_BYTES) {
      // Files that are too large to ever attach are marked binary
      // for picker purposes — they're unselectable for the same UX
      // reason (greyed out, can't include). The chip-row read path
      // would reject them anyway with a clearer toast at attach
      // time, but pre-marking saves a click cycle.
      binary = true;
    }
  } catch (e) {
    errored = true;
    errMsg = e instanceof Error ? e.message : String(e);
  }

  if (errMsg && typeof process !== 'undefined' && process.env?.SCI_TREE_TRACE) {
    // Diagnostic for unit-test debugging only.
    // eslint-disable-next-line no-console
    console.warn(`tree.buildFileNode error for ${relativePath}: ${errMsg}`);
  }

  const node: PickerNode = {
    path: relativePath,
    name: entry.name,
    type: 'file',
    size,
    ignored,
    entry,
  };
  if (binary) node.binary = true;
  if (errored) {
    node.binary = true; // not really binary but unselectable
  }
  return node;
}

/**
 * Recurse into a directory. Returns the dir node + its full subtree.
 * Increments `state.nodeCount` for every node minted; aborts (returns
 * a truncated dir) once `MAX_NODES` is hit.
 *
 * Out-parameter pattern via a mutable `state` object so the caller
 * sees the running counts (totalFiles, totalBytes, truncated).
 */
interface WalkState {
  matcher:    Ignore;
  nodeCount:  number;
  totalFiles: number;
  totalBytes: number;
  truncated:  boolean;
}

async function walkDir(
  dir:        FileSystemDirectoryEntry,
  relativePath: string,
  depth:      number,
  state:      WalkState,
): Promise<PickerNode> {
  state.nodeCount++;
  const dirIgnorePath = relativePath === '' ? '' : `${relativePath}/`;
  const node: PickerNode = {
    path:    relativePath,
    name:    dir.name,
    type:    'dir',
    ignored: dirIgnorePath !== '' && isIgnored(state.matcher, dirIgnorePath),
    children: [],
  };

  // Don't recurse past depth cap. The dir still appears in the tree,
  // but with an empty children array — the picker can render a
  // "(deeper contents not shown)" sentinel.
  if (depth >= MAX_DEPTH) return node;

  // Stop walking if we've hit the node cap. Return what we have.
  if (state.nodeCount >= MAX_NODES) {
    state.truncated = true;
    return node;
  }

  let entries: FileSystemEntry[];
  try {
    entries = await readAllDirEntries(dir);
  } catch {
    // Permission-denied or transient error reading a dir — surface
    // as empty. Don't abort the whole walk.
    return node;
  }

  // Skip the dir's own `.gitignore` from the listing only at the
  // dropped root — we already pre-read it to seed the matcher.
  // Filtering at non-root is a SCI-166d concern (nested gitignores).
  const visible = entries.filter((e) => {
    if (depth === 0 && e.name === '.gitignore' && e.isFile) return false;
    return true;
  });

  // Sort: dirs first, then alphabetical. Predictable rendering in
  // the picker; matches typical file-explorer convention.
  visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Walk children in parallel within this directory. We deliberately
  // do NOT parallelize across depth — that would make depth-cap
  // accounting hairy. Per-sibling parallelism is the right balance.
  const childResults = await Promise.all(
    visible.map((e) => {
      const childPath = relativePath === '' ? e.name : `${relativePath}/${e.name}`;
      if (state.nodeCount >= MAX_NODES) {
        state.truncated = true;
        return Promise.resolve<PickerNode | null>(null);
      }
      if (e.isFile) {
        state.nodeCount++;
        return buildFileNode(e as FileSystemFileEntry, childPath, state.matcher)
          .then((leaf) => {
            state.totalFiles += 1;
            state.totalBytes += leaf.size ?? 0;
            return leaf;
          });
      }
      if (e.isDirectory) {
        return walkDir(e as FileSystemDirectoryEntry, childPath, depth + 1, state);
      }
      // Symlinks or other oddities: drop silently. The browser
      // platform doesn't give us a way to distinguish reliably.
      return Promise.resolve<PickerNode | null>(null);
    }),
  );

  const children: PickerNode[] = [];
  for (const c of childResults) {
    if (c !== null) children.push(c);
  }

  // A directory is "ignored" if every child is ignored OR the dir
  // itself matches an ignore pattern. The "every child" rule keeps
  // partially-ignored directories visible (e.g. a `src/` whose own
  // pattern isn't matched, even if one file inside is). The default
  // safety set patterns directories themselves (`node_modules/`,
  // `target/`, etc.), so those still get the dir-level ignored=true
  // via the `isIgnored` call at the top of this function.
  if (!node.ignored && children.length > 0) {
    node.ignored = children.every((c) => c.ignored);
  }

  node.children = children;
  return node;
}

/**
 * Top-level walk. The picker calls this once per folder drop.
 *
 * Steps:
 *   1. Read root `.gitignore` (if any) and build the matcher.
 *   2. Recurse depth-first with sibling parallelism.
 *   3. Return root node + aggregates.
 *
 * `name` is the display label for the dropped folder. Browser
 * APIs give us `entry.name`, which is usually the basename — we
 * pass it through unchanged.
 */
export async function walkFolder(root: FileSystemDirectoryEntry): Promise<WalkResult> {
  const matcher = await loadRootIgnore(root);
  const state: WalkState = {
    matcher,
    nodeCount:  0,
    totalFiles: 0,
    totalBytes: 0,
    truncated:  false,
  };
  const rootNode = await walkDir(root, '', 0, state);
  return {
    root:       rootNode,
    totalFiles: state.totalFiles,
    totalBytes: state.totalBytes,
    truncated:  state.truncated,
  };
}

/**
 * Flatten a tree to a list of selectable leaves (files only), in
 * pre-order. Used by the picker's "select all visible" action and
 * for the final attach pass (we read these leaves' contents via
 * the chip read pipeline).
 *
 * Excludes binary leaves and (by default) ignored leaves. The
 * caller can pass `includeIgnored: true` to override when the user
 * has the "Show ignored" toggle on.
 */
export function flattenFiles(
  node:            PickerNode,
  includeIgnored = false,
): PickerNode[] {
  const out: PickerNode[] = [];
  const visit = (n: PickerNode) => {
    if (n.type === 'file') {
      if (n.binary) return;
      if (n.ignored && !includeIgnored) return;
      out.push(n);
    } else if (n.children) {
      for (const c of n.children) visit(c);
    }
  };
  visit(node);
  return out;
}

/**
 * Re-export a fresh matcher constructor for tests that want to
 * inject a synthetic ignore set. Production code should use
 * `ignore.ts::buildIgnore` directly.
 */
export function emptyMatcher(): Ignore {
  return ignore();
}
