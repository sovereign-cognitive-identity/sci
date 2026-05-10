import { readBatch, readOne } from '../reader';

/**
 * jsdom's `File` (which extends Blob) doesn't implement `.text()`
 * even on Node 22. We polyfill it per-file so the reader can run
 * end-to-end against real File objects. Real browsers have `.text()`
 * natively; this is purely a test-env workaround.
 */
function mkFile(name: string, content: string, type = 'text/plain'): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(content),
  });
  return file;
}

describe('SCI-166 reader', () => {
  describe('readOne', () => {
    it('accepts a small text file and produces an AttachedFile', async () => {
      const file = mkFile('hello.ts', 'export const x = 1;\n');
      const result = await readOne(file);
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') return;
      expect(result.value.name).toBe('hello.ts');
      expect(result.value.relativePath).toBe('hello.ts');
      expect(result.value.content).toBe('export const x = 1;\n');
      expect(result.value.language).toBe('ts');
      expect(result.value.tokenEstimate).toBeGreaterThan(0);
      expect(result.value.id).toMatch(/.+/);
      expect(result.warn).toBeNull();
    });

    it('rejects files over the size cap without reading content', async () => {
      // Construct a file whose reported `size` exceeds the cap.
      // The File API derives size from the blob parts, so we use
      // a string of the right length.
      const big = 'x'.repeat(6 * 1024 * 1024);
      const file = mkFile('big.txt', big);
      const result = await readOne(file);
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') return;
      expect(result.reason.reason).toBe('too-large');
      expect(result.reason.name).toBe('big.txt');
    });

    it('rejects a file whose content looks binary', async () => {
      const file = mkFile('binary.bin', 'hello\u0000world');
      const result = await readOne(file);
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') return;
      expect(result.reason.reason).toBe('binary');
    });

    it('warns (but accepts) a file over the soft warn threshold', async () => {
      const content = 'a'.repeat(150 * 1024); // 150 KB
      const file = mkFile('large.md', content);
      const result = await readOne(file);
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') return;
      expect(result.warn).not.toBeNull();
      expect(result.warn?.reason).toBe('large-warn');
      expect(result.warn?.size).toBe(content.length);
    });

    it('uses webkitRelativePath when present (folder drop)', async () => {
      const file = mkFile('main.py', 'print(1)\n');
      Object.defineProperty(file, 'webkitRelativePath', {
        value: 'project/src/main.py',
      });
      const result = await readOne(file, 'project');
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') return;
      // Base prefix `project/` should be stripped.
      expect(result.value.relativePath).toBe('src/main.py');
    });

    it('preserves full webkitRelativePath when no base prefix matches', async () => {
      const file = mkFile('main.py', 'print(1)\n');
      Object.defineProperty(file, 'webkitRelativePath', {
        value: 'other/src/main.py',
      });
      const result = await readOne(file, 'project');
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') return;
      expect(result.value.relativePath).toBe('other/src/main.py');
    });

    it('infers language from filename', async () => {
      const cases: Array<[string, string]> = [
        ['main.rs', 'rust'],
        ['Server.java', 'java'],
        ['style.scss', 'scss'],
        ['Dockerfile', 'dockerfile'],
        ['Makefile', 'makefile'],
      ];
      for (const [name, expected] of cases) {
        const result = await readOne(mkFile(name, 'content\n'));
        if (result.kind !== 'accepted') {
          throw new Error(`expected ${name} to be accepted`);
        }
        expect(result.value.language).toBe(expected);
      }
    });
  });

  describe('readBatch', () => {
    it('returns empty buckets for an empty input', async () => {
      const result = await readBatch([]);
      expect(result).toEqual({ accepted: [], rejected: [], warned: [] });
    });

    it('partitions a mixed batch into accepted / rejected / warned', async () => {
      const small  = mkFile('a.ts', 'const x = 1;\n');
      const binary = mkFile('b.bin', '\u0000\u0000\u0000\u0000');
      const huge   = mkFile('c.txt', 'x'.repeat(6 * 1024 * 1024));
      const warn   = mkFile('d.md', 'a'.repeat(150 * 1024));

      const result = await readBatch([small, binary, huge, warn]);
      expect(result.accepted.map((f) => f.name).sort()).toEqual(['a.ts', 'd.md']);
      expect(result.rejected.map((f) => f.name).sort()).toEqual(['b.bin', 'c.txt']);
      expect(result.warned.map((w) => w.name)).toEqual(['d.md']);
    });

    it('mints unique ids for each accepted file', async () => {
      const a = mkFile('a.ts', 'A\n');
      const b = mkFile('b.ts', 'B\n');
      const result = await readBatch([a, b]);
      expect(result.accepted).toHaveLength(2);
      expect(result.accepted[0].id).not.toBe(result.accepted[1].id);
    });
  });
});
