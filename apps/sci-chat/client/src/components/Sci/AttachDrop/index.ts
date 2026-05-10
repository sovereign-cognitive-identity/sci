/**
 * SCI-166 — drag-drop file/folder context attach.
 *
 * v1 (166a) ships pure logic + types.
 * v2 (166b) adds the UI mount: drop overlay, chip row, submit
 * interceptor. Single-file drops only; folder support follows in
 * 166c.
 */

export { default as AttachDropMount } from './mount';
export * from './types';
export {
  buildIgnore,
  filterIgnored,
  isIgnored,
} from './ignore';
export {
  estimateTokens,
  formatTokenCount,
  sumTokens,
  tokenWarnLevel,
} from './estimate';
export type { TokenWarnLevel } from './estimate';
export {
  composeMessage,
  renderFileBlock,
} from './format';
export {
  MAX_FILE_BYTES,
  WARN_FILE_BYTES,
  inferLanguage,
  isLikelyBinary,
  sizeVerdict,
} from './limits';
export type { SizeVerdict } from './limits';
export { readBatch, readOne } from './reader';
export { attachedFilesAtom, pinnedAtom } from './store';
