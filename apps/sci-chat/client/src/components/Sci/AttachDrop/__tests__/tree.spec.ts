/**
 * SCI-166c — tree walker tests.
 *
 * The walker consumes the browser's File and Directory Entry types,
 * which are callback-based and not provided in jsdom. We synthesize
 * minimal compliant fakes per test — just enough surface area for
 * `walkFolder` to consume them.
 *
 * Shape of a fake dir entry:
 *   { isFile: false, isDirectory: true, name, createReader() }
 *
 * Shape of a fake file entry:
 *   { isFile: true, isDirectory: false, name, file(cb) }
 *
 * Where `createReader()` returns an object with `readEntries(ok, err)`
 * that calls back ONCE with the batch then ONCE with [] to signal
 * EOF (matches the spec). `file(cb)` calls back with a Blob whose
 * `text()` and `slice()` are real (jsdom provides Blob).
 */

import { flattenFiles, MAX_DEPTH, walkFolder } from '../tree';
import type { PickerNode } from '../types';

// -- Fake-entry builders --------------------------------------------------

interface FakeFileSpec {
  name: string;
  content?: string;       // default '' (empty)
  size?: number;          // override Blob.size (synthesizing a huge file)
}

interface FakeDirSpec {
  name: string;
  children: (FakeFileSpec | FakeDirSpec)[];
}

function isDirSpec(spec: FakeFileSpec | FakeDirSpec): spec is FakeDirSpec {
  return 'children' in spec;
}

function makeFileEntry(spec: FakeFileSpec): FileSystemFileEntry {
  const content = spec.content ?? '';
  const blob = new Blob([content], { type: 'text/plain' });
  const file = new File([blob], spec.name, { type: 'text/plain' });

  // Override size if the test wants to simulate a > 5 MB file without
  // actually allocating it. Define a getter so it survives identity
  // checks.
  if (spec.size != null) {
    Object.defineProperty(file, 'size', { value: spec.size, configurable: true });
  }

  return {
    isFile: true,
    isDirectory: false,
    name: spec.name,
    fullPath: `/${spec.name}`,
    filesystem: undefined as unknown as FileSystem,
    getParent: () => { throw new Error('unused'); },
    file: (ok: (f: File) => void) => ok(file),
  } as unknown as FileSystemFileEntry;
}

function makeDirEntry(spec: FakeDirSpec): FileSystemDirectoryEntry {
  // Eagerly build child entries so the reader can hand them out.
  const childEntries = spec.children.map((c) =>
    isDirSpec(c) ? makeDirEntry(c) : makeFileEntry(c),
  );
  return {
    isFile: false,
    isDirectory: true,
    name: spec.name,
    fullPath: `/${spec.name}`,
    filesystem: undefined as unknown as FileSystem,
    getParent: () => { throw new Error('unused'); },
    createReader: () => {
      let served = false;
      return {
        readEntries: (
          ok: (entries: FileSystemEntry[]) => void,
        ) => {
          if (served) {
            ok([]);          // EOF
            return;
          }
          served = true;
          ok(childEntries);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

/**
 * Pretty-print the tree to a flat array of `<path>:<size>` strings.
 * Handy for snapshot-style assertions.
 */
function paths(node: PickerNode, out: string[] = []): string[] {
  if (node.type === 'file') {
    out.push(`${node.path}:${node.size ?? 0}${node.ignored ? '*' : ''}${node.binary ? '!' : ''}`);
  } else if (node.children) {
    for (const c of node.children) paths(c, out);
  }
  return out;
}

// -- Tests ---------------------------------------------------------------

describe('SCI-166c walkFolder', () => {
  it('walks a flat folder of text files', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'a.ts',     content: 'export const a = 1;' },
        { name: 'b.md',     content: '# hello' },
        { name: 'README',   content: 'no extension' },
      ],
    });
    const result = await walkFolder(root);
    expect(result.totalFiles).toBe(3);
    expect(paths(result.root).sort()).toEqual([
      'README:12',
      'a.ts:19',
      'b.md:7',
    ]);
    expect(result.truncated).toBe(false);
  });

  it('recurses into subdirectories with relative paths', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        {
          name: 'src',
          children: [
            { name: 'index.ts', content: 'x' },
            {
              name: 'sub',
              children: [{ name: 'deep.ts', content: 'yz' }],
            },
          ],
        },
        { name: 'package.json', content: '{}' },
      ],
    });
    const result = await walkFolder(root);
    expect(result.totalFiles).toBe(3);
    expect(paths(result.root).sort()).toEqual([
      // package-lock.json is in the default-ignore set; package.json
      // is NOT, so it should land selectable.
      'package.json:2',
      'src/index.ts:1',
      'src/sub/deep.ts:2',
    ]);
  });

  it('caps depth at MAX_DEPTH and stops recursing past it', async () => {
    // Build a chain root -> d1 -> d2 -> d3 -> d4 -> d5 -> d6 -> leaf.
    // MAX_DEPTH is 5 — anything at depth > 5 must not appear.
    const build = (n: number): FakeDirSpec => {
      if (n === 0) return { name: 'leaf-dir', children: [{ name: 'leaf.ts', content: 'l' }] };
      return { name: `d${n}`, children: [build(n - 1)] };
    };
    const root = makeDirEntry({ name: 'root', children: [build(MAX_DEPTH + 1)] });
    const result = await walkFolder(root);
    // Depth-5 leaf-dir at most; its child 'leaf.ts' is depth 6 and
    // should be cut off. So totalFiles is 0 — we never reached the
    // file leaf.
    expect(result.totalFiles).toBe(0);
  });

  it('applies the default ignore set to node_modules', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'src',          children: [{ name: 'index.ts', content: 'x' }] },
        { name: 'node_modules', children: [
          { name: 'a', children: [{ name: 'package.json', content: '{}' }] },
        ]},
      ],
    });
    const result = await walkFolder(root);
    const flat = paths(result.root);
    // The src file is kept; the node_modules file is present in the
    // tree but tagged ignored (so the picker can show it under the
    // toggle).
    expect(flat).toContain('src/index.ts:1');
    expect(flat).toContain('node_modules/a/package.json:2*');

    // flattenFiles with default `includeIgnored=false` excludes it.
    const selectable = flattenFiles(result.root, false).map((n) => n.path);
    expect(selectable).toEqual(['src/index.ts']);

    // With showIgnored, the ignored file becomes selectable.
    const all = flattenFiles(result.root, true).map((n) => n.path).sort();
    expect(all).toEqual(['node_modules/a/package.json', 'src/index.ts']);
  });

  it('honors a user .gitignore at the root', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: '.gitignore', content: 'secrets.env\nprivate/\n' },
        { name: 'secrets.env', content: 'KEY=1' },
        { name: 'public.env',  content: 'PUB=1' },
        { name: 'private', children: [{ name: 'k.pem', content: 'p' }] },
        { name: 'src',     children: [{ name: 'a.ts', content: 'a' }] },
      ],
    });
    const result = await walkFolder(root);
    const selectable = flattenFiles(result.root, false).map((n) => n.path).sort();
    // The .gitignore itself is filtered out of the listing at the
    // root (we pre-read it). secrets.env and private/* are ignored.
    expect(selectable).toEqual(['public.env', 'src/a.ts']);
  });

  it('marks files containing NUL bytes as binary', async () => {
    // The binary sniffer flags NUL in the first 4 KB.
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'text.txt', content: 'hello world' },
        { name: 'bin.dat',  content: 'before\u0000after' },
      ],
    });
    const result = await walkFolder(root);
    const flat = paths(result.root).sort();
    expect(flat).toEqual([
      'bin.dat:12!',   // ! = binary flag
      'text.txt:11',
    ]);
  });

  it('marks >5 MB files as binary (unselectable) without reading them', async () => {
    // 6 MB file — synthesized size only; content is short. The walker
    // must not try to slice + sniff this. The synthesized size > MAX
    // triggers the pre-mark binary path.
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'big.log', content: 'short', size: 6 * 1024 * 1024 },
        { name: 'small.txt', content: 'ok' },
      ],
    });
    const result = await walkFolder(root);
    const big = paths(result.root).find((s) => s.startsWith('big.log'));
    expect(big).toMatch(/!$/);   // binary-flagged
  });

  it('empty directories are present but contribute no files', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'empty', children: [] },
        { name: 'a.ts',  content: 'x' },
      ],
    });
    const result = await walkFolder(root);
    expect(result.totalFiles).toBe(1);
    // The empty dir's `ignored` flag defaults to false (no descendants
    // to derive from = falsy "every"). We don't bother asserting on
    // that — the picker shows empty dirs fine.
  });

  it('sorts directories before files, alphabetical within group', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'z.ts',   content: 'z' },
        { name: 'a.ts',   content: 'a' },
        { name: 'beta',   children: [] },
        { name: 'alpha',  children: [] },
      ],
    });
    const result = await walkFolder(root);
    const names = (result.root.children ?? []).map((n) => n.name);
    expect(names).toEqual(['alpha', 'beta', 'a.ts', 'z.ts']);
  });

  it('flattenFiles excludes binary leaves regardless of showIgnored', async () => {
    const root = makeDirEntry({
      name: 'proj',
      children: [
        { name: 'a.ts',     content: 'x' },
        { name: 'big.bin',  content: 'a\u0000b' },
      ],
    });
    const result = await walkFolder(root);
    expect(flattenFiles(result.root, false).map((n) => n.path)).toEqual(['a.ts']);
    expect(flattenFiles(result.root, true).map((n) => n.path)).toEqual(['a.ts']);
  });
});
