import { composeMessage, renderFileBlock } from '../format';
import type { AttachedFile } from '../types';

function makeFile(overrides: Partial<AttachedFile> = {}): AttachedFile {
  return {
    id: 'id-1',
    name: 'a.ts',
    relativePath: 'src/a.ts',
    size: 0,
    content: 'const x = 1;\n',
    language: 'ts',
    tokenEstimate: 5,
    ...overrides,
  };
}

describe('SCI-166 format', () => {
  describe('renderFileBlock', () => {
    it('renders the standard `## file:` block', () => {
      const block = renderFileBlock(makeFile());
      expect(block).toBe('## file: src/a.ts\n```ts\nconst x = 1;\n```\n');
    });

    it('omits language tag when language is empty', () => {
      const block = renderFileBlock(
        makeFile({ language: '', content: 'plain text\n' }),
      );
      expect(block).toBe('## file: src/a.ts\n```\nplain text\n```\n');
    });

    it('does not double the trailing newline when content already ends in \\n', () => {
      const block = renderFileBlock(makeFile({ content: 'one line\n' }));
      // The closing fence should sit on its own line, only one \n
      // between content and fence.
      expect(block.endsWith('one line\n```\n')).toBe(true);
      expect(block.includes('\n\n```\n')).toBe(false);
    });

    it('adds a trailing newline before the closing fence when content lacks one', () => {
      const block = renderFileBlock(makeFile({ content: 'no newline' }));
      expect(block.endsWith('no newline\n```\n')).toBe(true);
    });

    it('uses a longer fence when content contains a triple-backtick', () => {
      const tricky = '```js\ncode\n```\n';
      const block = renderFileBlock(
        makeFile({ content: tricky, language: 'md' }),
      );
      // Outer fence must be longer than the longest inner run.
      expect(block.startsWith('## file: src/a.ts\n````md\n')).toBe(true);
      expect(block.endsWith('````\n')).toBe(true);
    });
  });

  describe('composeMessage', () => {
    it('returns user text verbatim when no files', () => {
      expect(composeMessage([], 'hello world')).toBe('hello world');
    });

    it('returns just the blocks when user text is empty', () => {
      const out = composeMessage([makeFile()], '');
      expect(out).toBe('## file: src/a.ts\n```ts\nconst x = 1;\n```\n');
    });

    it('returns just the blocks when user text is whitespace', () => {
      const out = composeMessage([makeFile()], '   \n  ');
      expect(out).toBe('## file: src/a.ts\n```ts\nconst x = 1;\n```\n');
    });

    it('places blocks before the typed message with a blank line separator', () => {
      const out = composeMessage(
        [makeFile()],
        'What does this file do?',
      );
      expect(out).toBe(
        '## file: src/a.ts\n```ts\nconst x = 1;\n```\n\nWhat does this file do?',
      );
    });

    it('concatenates multiple blocks with single-newline separators', () => {
      const out = composeMessage(
        [
          makeFile({ id: '1', relativePath: 'a.ts', content: 'A\n' }),
          makeFile({ id: '2', relativePath: 'b.ts', content: 'B\n' }),
        ],
        'compare these',
      );
      expect(out).toBe(
        '## file: a.ts\n```ts\nA\n```\n\n## file: b.ts\n```ts\nB\n```\n\ncompare these',
      );
    });
  });
});
