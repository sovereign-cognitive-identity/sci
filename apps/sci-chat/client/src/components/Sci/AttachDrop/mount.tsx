/**
 * SCI-166b — the mount component that wires drag-drop attach into
 * LibreChat without touching upstream code.
 *
 * Responsibilities:
 *   1. Mount one document-level `drop` / `dragover` listener pair.
 *      We accept text files dropped anywhere over the chat input
 *      area (the form containing `#prompt-textarea`). Folder drops
 *      and image-only drops fall through to LibreChat's existing
 *      DragDropWrapper (which is mounted upstream and listens via
 *      react-dnd on the same surface).
 *
 *   2. Mount one capture-phase `submit` listener on document. When
 *      a form containing `#prompt-textarea` submits and we have
 *      chips queued, we rewrite the textarea value to prepend the
 *      file blocks BEFORE LibreChat's react-hook-form reads it.
 *      Implementation detail: react-hook-form's `handleSubmit`
 *      reads the field state at submit time; we write the new
 *      value via the native `value` setter + dispatch an `input`
 *      event so RHF's onChange handler picks it up. This works
 *      because RHF stays in sync with the DOM on change.
 *
 *   3. Render the chip row + the drop overlay.
 *
 * Folder drops, multi-file drops, binary rejection, `.gitignore`
 * filtering — all deferred to SCI-166c/d. v1 (this commit) handles
 * a single text-file drop end-to-end.
 *
 * Routing rule from the SCI-166 plan:
 *   - Drop event contains any item with `kind === 'file'` AND any
 *     file is identified as text-like → we claim the drop and
 *     `preventDefault()` so LibreChat's react-dnd doesn't double-
 *     handle it.
 *   - Otherwise → let the event bubble to LibreChat's handler
 *     (images, RAG attach, code interpreter uploads).
 *
 * Why intercept at the form `submit` event and not by wrapping
 * `useSubmitMessage`: wrapping the hook would require an upstream
 * edit. The capture-phase listener is the only zero-touch path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRecoilState, useResetRecoilState } from 'recoil';
import type { TextareaHTMLAttributes } from 'react';

import { useToastContext } from '@librechat/client';

import ChipRow from './ChipRow';
import DropOverlay from './DropOverlay';
import FolderPicker from './FolderPicker';
import { composeMessage } from './format';
import { readBatch } from './reader';
import { attachedFilesAtom, pinnedAtom } from './store';
import { sumTokens, formatTokenCount } from './estimate';
import type { AttachedFile, RejectedFile } from './types';

/** ID set by LibreChat on the chat input — see client/src/common/types.ts. */
const TEXTAREA_ID = 'prompt-textarea';

/**
 * Whether a drag payload is something we'd handle. We can only
 * inspect `dataTransfer.types` during `dragover` (no read of the
 * actual files until drop). The presence of `'Files'` in types is
 * the standard signal that the user is dragging filesystem files.
 */
function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes('Files');
}

/**
 * Locate the LibreChat form that contains the chat input textarea.
 * Returns null when there is no chat surface in the current route
 * (e.g. settings page).
 */
function findChatForm(): HTMLFormElement | null {
  const ta = document.getElementById(TEXTAREA_ID) as HTMLTextAreaElement | null;
  if (!ta) return null;
  return ta.closest('form');
}

/**
 * Write a new value into the chat textarea AND fire a synthetic
 * input event so react-hook-form (and LibreChat's `useWatch`)
 * picks up the change. Without the synthetic event, RHF's internal
 * state still holds the old value at submit time.
 */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  // React tracks the native setter on the prototype; using the
  // standard setter writes the value but React won't notice unless
  // we go through the descriptor. This is the standard workaround.
  const proto = Object.getPrototypeOf(textarea) as TextareaHTMLAttributes<HTMLTextAreaElement>;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = descriptor?.set;
  if (setter) {
    setter.call(textarea, value);
  } else {
    textarea.value = value;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function rejectionMessage(rejected: RejectedFile[]): string {
  if (rejected.length === 0) return '';
  if (rejected.length === 1) {
    const r = rejected[0];
    if (r.reason === 'too-large') return `Rejected ${r.name}: file too large (>5 MB)`;
    if (r.reason === 'binary')    return `Rejected ${r.name}: binary files not supported`;
    if (r.reason === 'read-error') return `Could not read ${r.name}: ${r.detail ?? 'read error'}`;
    return `Rejected ${r.name}`;
  }
  return `Rejected ${rejected.length} ${plural(rejected.length, 'file', 'files')}`;
}

export default function AttachDropMount() {
  const [files,   setFiles]    = useRecoilState(attachedFilesAtom);
  const [pinned,  setPinned]   = useRecoilState(pinnedAtom);
  const clearAll               = useResetRecoilState(attachedFilesAtom);
  const [dragActive, setDragActive] = useState(false);
  const [pickerEntry, setPickerEntry] = useState<FileSystemDirectoryEntry | null>(null);
  const { showToast }          = useToastContext();

  const caption = useMemo(() => {
    if (files.length === 0) return 'drop a text file to attach as context';
    const total = sumTokens(files);
    return `${files.length} ${plural(files.length, 'file', 'files')} attached · ~${formatTokenCount(total)}`;
  }, [files]);

  /**
   * Add files to the chip set after reading + classifying. Pure
   * state update plus toasts; no DOM side effects.
   */
  const acceptFiles = useCallback(
    async (raw: File[]) => {
      const { accepted, rejected, warned } = await readBatch(raw);

      if (accepted.length > 0) {
        setFiles((prev) => [...prev, ...accepted]);
      }

      if (rejected.length > 0) {
        showToast({ message: rejectionMessage(rejected), status: 'error' });
      }
      if (warned.length > 0) {
        const sizes = warned.map((w) => `${w.name} (${(w.size / 1024).toFixed(0)} KB)`);
        showToast({
          message: `Large ${plural(warned.length, 'file', 'files')}: ${sizes.join(', ')}`,
          status: 'warning',
        });
      }
    },
    [setFiles, showToast],
  );

  // -------------------------------------------------------------
  //  Drag + drop listeners
  // -------------------------------------------------------------
  //
  // We attach to document with capture phase so we run before any
  // upstream react-dnd handlers. We only `preventDefault()` /
  // `stopPropagation()` when the drop target is over the chat form
  // AND the payload contains files — otherwise we let the event
  // continue to LibreChat's own DragDropWrapper.
  //
  // SCI-166b scope: single text file. Folder drops are deferred to
  // SCI-166c (which will route to a tree picker modal). For this
  // commit, if more than one file is dropped, we accept all of
  // them as a batch; folders dropped from Finder show up as
  // entries with `kind === 'file'` and `type === ''` and either
  // size 0 or fail the binary sniff — either way they get
  // rejected with a sensible message. Folder support comes next.
  useEffect(() => {
    const onDragOver = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      const form = findChatForm();
      if (!form) return;
      const target = ev.target as Node | null;
      if (!target || !form.contains(target)) {
        // Outside the chat form — don't claim the drag, let
        // LibreChat's image-paste handler (if any) see it.
        setDragActive(false);
        return;
      }
      ev.preventDefault();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = 'copy';
      }
      setDragActive(true);
    };

    const onDragLeave = (ev: DragEvent) => {
      // dragleave fires on every child crossed during a drag.
      // Only deactivate when leaving the document body entirely
      // (relatedTarget is null when the cursor exits the window).
      if (ev.relatedTarget == null) {
        setDragActive(false);
      }
    };

    const onDrop = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      const form = findChatForm();
      if (!form) return;
      const target = ev.target as Node | null;
      if (!target || !form.contains(target)) return;

      ev.preventDefault();
      ev.stopPropagation();
      setDragActive(false);

      // SCI-166c — inspect dataTransfer.items via webkitGetAsEntry()
      // to detect folder drops. Folder → open picker modal.
      // All-files → batch-read as before. Mixed → batch-read the
      // files now and queue the first folder for the picker after
      // (single-folder-at-a-time UX simplifies the modal lifecycle).
      const items: DataTransferItem[] = ev.dataTransfer?.items
        ? Array.from(ev.dataTransfer.items)
        : [];
      const entries = items
        .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
        .filter((e): e is FileSystemEntry => e != null);

      const folder = entries.find((e): e is FileSystemDirectoryEntry => e.isDirectory);
      const fileEntries = entries.filter(
        (e): e is FileSystemFileEntry => e.isFile,
      );

      // Read any plain-file siblings immediately. Use the original
      // File handles from dataTransfer.files for the ones that have
      // them — entry.file() works too but the direct File handle
      // avoids an extra async hop.
      if (fileEntries.length > 0 || (!folder && ev.dataTransfer?.files?.length)) {
        const directFiles: File[] = ev.dataTransfer?.files
          ? Array.from(ev.dataTransfer.files).filter((f) => {
              // Crude: dataTransfer.files for a folder drop on macOS
              // Chrome contains a stub File for the folder with size 0
              // and no type. The webkitGetAsEntry path is authoritative;
              // we use it to filter out those stubs.
              return entries.some(
                (e) => e.isFile && e.name === f.name,
              );
            })
          : [];
        if (directFiles.length > 0) {
          void acceptFiles(directFiles);
        }
      }

      if (folder) {
        setPickerEntry(folder);
      }
    };

    document.addEventListener('dragover',  onDragOver,  true);
    document.addEventListener('dragleave', onDragLeave, true);
    document.addEventListener('drop',      onDrop,      true);
    return () => {
      document.removeEventListener('dragover',  onDragOver,  true);
      document.removeEventListener('dragleave', onDragLeave, true);
      document.removeEventListener('drop',      onDrop,      true);
    };
  }, [acceptFiles]);

  // -------------------------------------------------------------
  //  Submit interceptor
  // -------------------------------------------------------------
  //
  // We listen for `submit` in the capture phase. When it fires on
  // the chat form and we have chips queued, we splice the file
  // blocks into the textarea value. This works because react-
  // hook-form reads the field state when handleSubmit runs, and
  // we rewrite that state synchronously before the bubbling phase
  // reaches the form's onSubmit handler.
  //
  // After successful submission we clear chips unless pinned.
  useEffect(() => {
    const onSubmit = (ev: Event) => {
      const form = ev.target as HTMLFormElement | null;
      if (!form || form.tagName !== 'FORM') return;
      const textarea = form.querySelector<HTMLTextAreaElement>(`#${TEXTAREA_ID}`);
      if (!textarea) return;
      if (files.length === 0) return;

      const composed = composeMessage(files, textarea.value);
      setTextareaValue(textarea, composed);

      // Defer the clear to the next microtask so the form handler
      // gets a chance to read the rewritten value before we wipe
      // state. (RHF reads synchronously from its watched state,
      // not directly from the DOM, but we already nudged RHF via
      // the input event above; either way, deferring keeps us safe.)
      queueMicrotask(() => {
        if (!pinned) {
          clearAll();
        }
      });
    };

    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, [files, pinned, clearAll]);

  // -------------------------------------------------------------
  //  Render: chip row + drop overlay
  // -------------------------------------------------------------
  const onRemove = useCallback(
    (id: string) => {
      setFiles((prev) => prev.filter((f) => f.id !== id));
    },
    [setFiles],
  );

  const onTogglePinned = useCallback(() => {
    setPinned((p) => !p);
  }, [setPinned]);

  return (
    <>
      <DropOverlay active={dragActive} caption={caption} />
      <ChipRow
        files={files as AttachedFile[]}
        pinned={pinned}
        onRemove={onRemove}
        onTogglePinned={onTogglePinned}
        onClearAll={clearAll}
      />
      {pickerEntry && (
        <FolderPicker
          rootEntry={pickerEntry}
          onClose={() => setPickerEntry(null)}
        />
      )}
    </>
  );
}
