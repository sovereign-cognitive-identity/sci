/**
 * Render attached files as the prompt-body text blocks that get
 * prepended to the user's typed message.
 *
 * Format (matches Claude Code / Cursor convention — well-trained
 * on by all major coding models):
 *
 *     ## file: relative/path/to/file.ext
 *     ```language
 *     <file contents>
 *     ```
 *
 *     ## file: other.py
 *     ```python
 *     ...
 *     ```
 *
 *     <user's typed message>
 *
 * Empty language tag means a bare fence. Trailing newline of each
 * block separates from the next; a blank line separates blocks
 * from the user's typed text.
 *
 * Closing fence is `\`\`\`` regardless of content. If a file
 * itself contains a triple-backtick fence (e.g. a markdown file
 * with code blocks), we use a longer fence so the outer fence
 * remains the outer fence — same rule CommonMark uses.
 */

import type { AttachedFile } from './types';

/**
 * Pick a fence string long enough that the content can't escape it.
 * Scans for the longest backtick run in the content and adds one,
 * with a minimum of 3 (the default).
 */
function pickFence(content: string): string {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x60 /* ` */) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  const length = Math.max(3, longest + 1);
  return '`'.repeat(length);
}

/**
 * Render a single file as a `## file:` block. Always ends with a
 * trailing newline so concatenation lands subsequent blocks on a
 * fresh line.
 */
export function renderFileBlock(file: AttachedFile): string {
  const fence = pickFence(file.content);
  const info = file.language;
  // Avoid a stray trailing newline doubling-up — strip exactly one
  // trailing \n if present so the closing fence sits on its own line
  // either way.
  const body = file.content.endsWith('\n') ? file.content.slice(0, -1) : file.content;
  return `## file: ${file.relativePath}\n${fence}${info}\n${body}\n${fence}\n`;
}

/**
 * Compose the full outbound message text from a chip set and the
 * user's typed message. Order:
 *
 *   <file block>
 *   <file block>
 *   ...
 *   <blank line>
 *   <user text>
 *
 * When there are no chips, returns `userText` verbatim. When
 * `userText` is empty, returns just the blocks (we don't pad with
 * a trailing blank line in that case).
 */
export function composeMessage(files: AttachedFile[], userText: string): string {
  if (files.length === 0) return userText;

  const blocks: string[] = [];
  for (const file of files) {
    blocks.push(renderFileBlock(file));
  }
  const joined = blocks.join('\n');
  const trimmedUser = userText.trim();
  if (trimmedUser.length === 0) {
    return joined;
  }
  return `${joined}\n${userText}`;
}
