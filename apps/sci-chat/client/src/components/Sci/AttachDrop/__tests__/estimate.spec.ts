import {
  estimateTokens,
  formatTokenCount,
  sumTokens,
  tokenWarnLevel,
} from '../estimate';

describe('SCI-166 estimate', () => {
  describe('estimateTokens', () => {
    it('returns wrapper overhead for empty content', () => {
      // 30 wrapper chars / 4 = 7.5 -> ceil -> 8
      expect(estimateTokens('')).toBe(8);
    });

    it('scales roughly linearly with content size', () => {
      const small = estimateTokens('a'.repeat(100));
      const big = estimateTokens('a'.repeat(10_000));
      expect(big).toBeGreaterThan(small * 50);
      expect(big).toBeLessThan(small * 200);
    });

    it('never returns a fractional token', () => {
      for (let i = 0; i < 50; i++) {
        const n = estimateTokens('x'.repeat(i));
        expect(Number.isInteger(n)).toBe(true);
      }
    });
  });

  describe('sumTokens', () => {
    it('returns 0 for empty list', () => {
      expect(sumTokens([])).toBe(0);
    });

    it('sums per-file estimates', () => {
      expect(
        sumTokens([
          { tokenEstimate: 10 },
          { tokenEstimate: 25 },
          { tokenEstimate: 0 },
        ]),
      ).toBe(35);
    });
  });

  describe('formatTokenCount', () => {
    it('renders sub-1000 counts as plain integers', () => {
      expect(formatTokenCount(0)).toBe('0 tokens');
      expect(formatTokenCount(999)).toBe('999 tokens');
    });

    it('switches to "k" suffix at 1000', () => {
      expect(formatTokenCount(1000)).toBe('1.0k tokens');
      expect(formatTokenCount(4_200)).toBe('4.2k tokens');
      expect(formatTokenCount(42_500)).toBe('42.5k tokens');
    });
  });

  describe('tokenWarnLevel', () => {
    it('returns green below 8k', () => {
      expect(tokenWarnLevel(0)).toBe('green');
      expect(tokenWarnLevel(7_999)).toBe('green');
    });
    it('returns yellow between 8k and 32k', () => {
      expect(tokenWarnLevel(8_000)).toBe('yellow');
      expect(tokenWarnLevel(31_999)).toBe('yellow');
    });
    it('returns red at and above 32k', () => {
      expect(tokenWarnLevel(32_000)).toBe('red');
      expect(tokenWarnLevel(500_000)).toBe('red');
    });
  });
});
