/**
 * Reads a browser `File` into an `AttachedFile` chip, enforcing the
 * size / binary / language policies from `limits.ts`. Returns the
 * accepted chip, a rejection reason, or a warn-but-accept signal.
 *
 * Pure async — no UI side effects. The caller toasts on rejection
 * and pushes accepted chips into the Recoil atom.
 *
 * id generation: we use `crypto.randomUUID()` when available
 * (jsdom test env doesn't always expose it, so we fall back to a
 * timestamp+random combo). The id is stable per-drop, used as
 * React key and for chip removal.
 */

import {
  MAX_FILE_BYTES,
  WARN_FILE_BYTES,
  inferLanguage,
  isLikelyBinary,
} from './limits';
import { estimateTokens } from './estimate';
import type { AttachedFile, ReadBatchResult, RejectedFile, WarnedFile } from './types';

function mintId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `chip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Pull a `webkitRelativePath` if the browser surfaced one (from a
 * folder drop), else fall back to `file.name`. We never see absolute
 * disk paths in browser file APIs — the closest the platform gives
 * us is the folder-relative path inside a dropped directory.
 */
function relativePathFor(file: File, base?: string): string {
  type WithWebkit = File & { webkitRelativePath?: string };
  const rel = (file as WithWebkit).webkitRelativePath;
  if (rel && rel.length > 0) {
    if (base && rel.startsWith(`${base}/`)) {
      return rel.slice(base.length + 1);
    }
    return rel;
  }
  return file.name;
}

/**
 * Read a single file and turn it into an `AttachedFile` chip, or
 * report why it was rejected.
 *
 * Size cap is checked BEFORE reading the bytes so we never load a
 * 200MB file into a string just to reject it. Binary sniff happens
 * after text decode (the encoding does the heavy lifting; bad UTF-8
 * produces replacement chars which trip the heuristic).
 */
export async function readOne(
  file: File,
  base?: string,
): Promise<
  | { kind: 'accepted'; value: AttachedFile; warn: WarnedFile | null }
  | { kind: 'rejected'; reason: RejectedFile }
> {
  if (file.size > MAX_FILE_BYTES) {
    return {
      kind: 'rejected',
      reason: { name: file.name, reason: 'too-large', detail: `${file.size} bytes` },
    };
  }

  let content: string;
  try {
    content = await file.text();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      kind: 'rejected',
      reason: { name: file.name, reason: 'read-error', detail },
    };
  }

  if (isLikelyBinary(content)) {
    return {
      kind: 'rejected',
      reason: { name: file.name, reason: 'binary' },
    };
  }

  const relativePath = relativePathFor(file, base);
  const language     = inferLanguage(file.name);
  const tokenEstimate = estimateTokens(content);

  const warn: WarnedFile | null =
    file.size > WARN_FILE_BYTES
      ? { name: file.name, reason: 'large-warn', size: file.size }
      : null;

  return {
    kind: 'accepted',
    value: {
      id:   mintId(),
      name: file.name,
      relativePath,
      size: file.size,
      content,
      language,
      tokenEstimate,
    },
    warn,
  };
}

/**
 * Read a batch of files in parallel, partitioned into accepted /
 * warned / rejected. Empty input returns empty buckets — no work
 * done.
 */
export async function readBatch(files: File[], base?: string): Promise<ReadBatchResult> {
  if (files.length === 0) {
    return { accepted: [], rejected: [], warned: [] };
  }

  const results = await Promise.all(files.map((f) => readOne(f, base)));

  const accepted: AttachedFile[] = [];
  const rejected: RejectedFile[] = [];
  const warned:   WarnedFile[]   = [];

  for (const r of results) {
    if (r.kind === 'accepted') {
      accepted.push(r.value);
      if (r.warn) warned.push(r.warn);
    } else {
      rejected.push(r.reason);
    }
  }

  return { accepted, rejected, warned };
}
