import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRedeemCode } from '~/server/utils/redeem-code';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('generateRedeemCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['MB', 'CS'] as const)('builds a %s-XXXX-XXXX code', (prefix) => {
    expect(generateRedeemCode(prefix)).toMatch(new RegExp(`^${prefix}-[A-Z0-9]{4}-[A-Z0-9]{4}$`));
  });

  it('does not draw from Math.random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const codes = new Set(Array.from({ length: 100 }, () => generateRedeemCode('MB')));
    expect(codes.size).toBe(100);
  });

  it('draws every character of A-Z0-9', () => {
    const seen = new Set(
      Array.from({ length: 2000 }, () => generateRedeemCode('CS').slice(3).replace('-', '')).join(
        ''
      )
    );
    expect([...seen].sort().join('')).toBe([...ALPHABET].sort().join(''));
  });
});
