/**
 * SCI-166 — drag-drop file/folder context attach.
 *
 * Types for the snapshot-attach feature. Snapshots are ephemeral
 * file contents inlined into the next message body as text blocks.
 * Distinct from LibreChat's existing file-upload pipeline (RAG /
 * agents / images) — see `apps/sci-chat/client/src/components/Sci/
 * AttachDrop/README.md` (when written) for the routing rule.
 */

/**
 * A single attached file (a "chip"). Held in a Recoil atom and
 * rendered above the chat input. Cleared after send unless the
 * user opts to keep the set pinned for the thread.
 */
export interface AttachedFile {
  /**
   * Stable identifier. Used as React key and for removal. We mint
   * a fresh one for every drop (even if the same path is re-dropped)
   * so the chip animation re-fires.
   */
  id: string;
  /**
   * Display name shown on the chip. Usually the basename. For folder
   * drops, the path relative to the dropped root.
   */
  name: string;
  /**
   * The path used in the `## file: <path>` header that lands in the
   * outbound message. Relative to the active project working
   * directory if SCI-159 Project Mode is set, else to the dropped
   * folder root, else basename.
   */
  relativePath: string;
  /**
   * The absolute path on disk, if the browser surfaced it (it rarely
   * does — `webkitGetAsEntry` gives a webkit-relative path). Used
   * for the tooltip if available; otherwise omitted.
   */
  absolutePath?: string;
  /** File size in bytes. */
  size: number;
  /** UTF-8 file contents. */
  content: string;
  /**
   * Best-guess code-fence language tag. Empty string when unknown
   * (no fence info string written).
   */
  language: string;
  /** Rough token estimate (chars / 4). */
  tokenEstimate: number;
}

/**
 * Result of a drop classification pass — the routing rule from
 * SCI-166's plan. `kind` discriminates the action the caller takes.
 */
export type DropClassification =
  | { kind: 'text-files'; files: File[] }
  | { kind: 'folder'; entry: FileSystemDirectoryEntry; name: string }
  | { kind: 'images-only'; files: File[] }
  | { kind: 'mixed'; texts: File[]; images: File[] }
  | { kind: 'empty' }
  | { kind: 'rejected'; reason: string };

/**
 * Per-file rejection reasons surfaced as toasts. Kept as a closed
 * union so callsites must handle every reason explicitly.
 */
export type RejectReason =
  | 'too-large'
  | 'binary'
  | 'read-error'
  | 'unreadable-permission';

export interface RejectedFile {
  name: string;
  reason: RejectReason;
  detail?: string;
}

/**
 * Soft-warning bucket (file accepted but the user should know).
 */
export interface WarnedFile {
  name: string;
  reason: 'large-warn';
  size: number;
}

/**
 * Outcome of reading a batch of files for chip insertion. The
 * caller surfaces `rejected` + `warned` as toasts and pushes
 * `accepted` into the Recoil atom.
 */
export interface ReadBatchResult {
  accepted: AttachedFile[];
  rejected: RejectedFile[];
  warned: WarnedFile[];
}

/**
 * Picker tree node — used by the folder picker modal. Built by
 * walking `FileSystemDirectoryEntry` recursively and tagging each
 * leaf with its `.gitignore` verdict.
 */
export interface PickerNode {
  /** Path relative to the picker root (the dropped folder). */
  path: string;
  /** Display name (basename). */
  name: string;
  /** File or directory. Directories have `children`. */
  type: 'file' | 'dir';
  /** Bytes — leaves only. Directories show summed total at render. */
  size?: number;
  /**
   * Whether this path would be ignored by the combined .gitignore +
   * default safety set. Leaves carry this directly; dirs are
   * "ignored" if every child is ignored.
   */
  ignored: boolean;
  /**
   * Whether the file is binary by sniff. Binary files are always
   * unselectable and shown greyed-out.
   */
  binary?: boolean;
  /**
   * Browser FS entry handle. Held so the picker can read contents
   * without re-walking the tree. Undefined for synthesized nodes.
   */
  entry?: FileSystemFileEntry;
  /** Subtree, present for `type: 'dir'`. */
  children?: PickerNode[];
}
