/**
 * SCI-166 — drag-drop file/folder context attach.
 *
 * v1 (166a) ships pure logic + types. UI integration lands in 166b.
 */

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
