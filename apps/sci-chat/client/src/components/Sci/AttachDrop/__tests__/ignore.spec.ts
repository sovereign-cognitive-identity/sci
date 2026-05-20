import { buildIgnore, filterIgnored, isIgnored } from '../ignore';

describe('SCI-166 ignore', () => {
  describe('default safety set', () => {
    const matcher = buildIgnore('');

    it('ignores node_modules', () => {
      expect(isIgnored(matcher, 'node_modules/foo/index.js')).toBe(true);
      expect(isIgnored(matcher, 'apps/x/node_modules/y/z.js')).toBe(true);
    });

    it('ignores .git', () => {
      expect(isIgnored(matcher, '.git/HEAD')).toBe(true);
      expect(isIgnored(matcher, '.git/objects/abc')).toBe(true);
    });

    it('ignores build artifact dirs', () => {
      expect(isIgnored(matcher, 'dist/bundle.js')).toBe(true);
      expect(isIgnored(matcher, 'target/release/foo')).toBe(true);
      expect(isIgnored(matcher, 'build/output.txt')).toBe(true);
      expect(isIgnored(matcher, '.next/static/chunks/x.js')).toBe(true);
    });

    it('ignores .DS_Store anywhere', () => {
      expect(isIgnored(matcher, '.DS_Store')).toBe(true);
      expect(isIgnored(matcher, 'src/.DS_Store')).toBe(true);
    });

    it('ignores lockfiles', () => {
      expect(isIgnored(matcher, 'package-lock.json')).toBe(true);
      expect(isIgnored(matcher, 'yarn.lock')).toBe(true);
      expect(isIgnored(matcher, 'pnpm-lock.yaml')).toBe(true);
    });

    it('does not ignore normal source files', () => {
      expect(isIgnored(matcher, 'src/index.ts')).toBe(false);
      expect(isIgnored(matcher, 'README.md')).toBe(false);
      expect(isIgnored(matcher, 'package.json')).toBe(false);
    });
  });

  describe('user .gitignore is layered on top', () => {
    const matcher = buildIgnore(
      ['# user file', 'secrets.env', 'private/', '*.bak'].join('\n'),
    );

    it('respects user-added file patterns', () => {
      expect(isIgnored(matcher, 'secrets.env')).toBe(true);
      expect(isIgnored(matcher, 'foo.bak')).toBe(true);
      expect(isIgnored(matcher, 'src/foo.bak')).toBe(true);
    });

    it('respects user-added dir patterns', () => {
      expect(isIgnored(matcher, 'private/key.pem')).toBe(true);
    });

    it('still applies the default safety set', () => {
      expect(isIgnored(matcher, 'node_modules/x.js')).toBe(true);
    });

    it('does not ignore files outside the user patterns', () => {
      expect(isIgnored(matcher, 'public.env')).toBe(false);
      expect(isIgnored(matcher, 'public/index.html')).toBe(false);
    });
  });

  describe('isIgnored path normalization', () => {
    const matcher = buildIgnore('');

    it('handles Windows backslashes', () => {
      expect(isIgnored(matcher, 'node_modules\\foo\\bar.js')).toBe(true);
    });

    it('strips a leading ./ which `ignore` rejects', () => {
      expect(isIgnored(matcher, './node_modules/x.js')).toBe(true);
    });

    it('returns false on empty / current-dir paths', () => {
      expect(isIgnored(matcher, '')).toBe(false);
      expect(isIgnored(matcher, '.')).toBe(false);
    });
  });

  describe('filterIgnored', () => {
    const matcher = buildIgnore('');

    it('partitions a list of paths', () => {
      const result = filterIgnored(matcher, [
        'src/index.ts',
        'node_modules/foo.js',
        'README.md',
        '.git/HEAD',
        'package.json',
      ]);
      expect(result.kept.sort()).toEqual(
        ['README.md', 'package.json', 'src/index.ts'].sort(),
      );
      expect(result.dropped.sort()).toEqual(
        ['.git/HEAD', 'node_modules/foo.js'].sort(),
      );
    });

    it('returns empty buckets for an empty input', () => {
      const result = filterIgnored(matcher, []);
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([]);
    });
  });
});
