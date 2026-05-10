import {
  MAX_FILE_BYTES,
  WARN_FILE_BYTES,
  inferLanguage,
  isLikelyBinary,
  sizeVerdict,
} from '../limits';

describe('SCI-166 limits', () => {
  describe('sizeVerdict', () => {
    it('returns ok for small files', () => {
      expect(sizeVerdict(0)).toBe('ok');
      expect(sizeVerdict(1024)).toBe('ok');
      expect(sizeVerdict(WARN_FILE_BYTES)).toBe('ok');
    });

    it('returns warn just above the warn threshold', () => {
      expect(sizeVerdict(WARN_FILE_BYTES + 1)).toBe('warn');
      expect(sizeVerdict(1024 * 1024)).toBe('warn');
    });

    it('returns reject above the hard cap', () => {
      expect(sizeVerdict(MAX_FILE_BYTES + 1)).toBe('reject');
      expect(sizeVerdict(50 * 1024 * 1024)).toBe('reject');
    });
  });

  describe('inferLanguage', () => {
    it('infers common code languages from extension', () => {
      expect(inferLanguage('foo.ts')).toBe('ts');
      expect(inferLanguage('foo.tsx')).toBe('tsx');
      expect(inferLanguage('a/b/main.py')).toBe('python');
      expect(inferLanguage('src/lib.rs')).toBe('rust');
      expect(inferLanguage('Service.java')).toBe('java');
      expect(inferLanguage('Main.kt')).toBe('kotlin');
    });

    it('case-insensitive on extension', () => {
      expect(inferLanguage('FOO.TS')).toBe('ts');
      expect(inferLanguage('Foo.PY')).toBe('python');
    });

    it('handles basenames without extensions', () => {
      expect(inferLanguage('Dockerfile')).toBe('dockerfile');
      expect(inferLanguage('dockerfile')).toBe('dockerfile');
      expect(inferLanguage('path/to/Makefile')).toBe('makefile');
    });

    it('returns empty string for unknown extensions', () => {
      expect(inferLanguage('nothing')).toBe('');
      expect(inferLanguage('foo.xyz')).toBe('');
      expect(inferLanguage('a.unknown.ext')).toBe('');
    });

    it('does not crash on edge filenames', () => {
      expect(inferLanguage('')).toBe('');
      expect(inferLanguage('.')).toBe('');
      expect(inferLanguage('.hidden')).toBe('');
    });
  });

  describe('isLikelyBinary', () => {
    it('flags NUL-containing strings', () => {
      expect(isLikelyBinary('hello\u0000world')).toBe(true);
    });

    it('flags strings full of replacement characters', () => {
      expect(isLikelyBinary('\ufffd'.repeat(100))).toBe(true);
    });

    it('passes plain ASCII text', () => {
      expect(isLikelyBinary('hello world')).toBe(false);
      expect(isLikelyBinary('const x = 1;\n')).toBe(false);
    });

    it('passes UTF-8 text with whitespace', () => {
      expect(isLikelyBinary('line one\nline two\r\nline three')).toBe(false);
      expect(isLikelyBinary('\ttabbed\tcontent')).toBe(false);
    });

    it('passes empty content (treat as text)', () => {
      expect(isLikelyBinary('')).toBe(false);
    });

    it('flags content with > 30 percent control bytes', () => {
      // 10 chars: 4 control chars (not tab/LF/CR) -> 40 percent -> binary
      const s = 'a\u0001b\u0002c\u0003d\u0004e';
      expect(isLikelyBinary(s)).toBe(true);
    });

    it('allows occasional control chars below threshold', () => {
      // 1 control char in 100 chars = 1% -> still text
      const s = 'a'.repeat(99) + '\u0001';
      expect(isLikelyBinary(s)).toBe(false);
    });
  });
});
