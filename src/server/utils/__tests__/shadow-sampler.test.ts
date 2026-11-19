import { describe, expect, it } from 'vitest';
import { createPerSecondBuckets, envNumber } from '~/server/utils/shadow-sampler';

describe('createPerSecondBuckets', () => {
  it('starts full, spends one token per take, and refills continuously up to one second', () => {
    let t = 1_000;
    const b = createPerSecondBuckets(['a', 'b'] as const, 3, () => t);
    expect([b.take('a'), b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, true, false]);
    t += 333; // 0.999 of a token
    expect(b.take('a')).toBe(false);
    t += 1; // 0.999 + 0.003 since the last take: one token
    expect(b.take('a')).toBe(true);
    t += 60_000; // a long idle refills to the cap (3), not beyond
    expect([b.take('a'), b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, true, false]);
  });

  it('keeps one bucket per endpoint', () => {
    const b = createPerSecondBuckets(['a', 'b'] as const, 1, () => 0);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    expect(b.take('b')).toBe(true);
  });

  it('holds at least one token, so a rate below 1/s still admits a sample', () => {
    let t = 0;
    const b = createPerSecondBuckets(['a'] as const, 0.5, () => t);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    t += 1_999; // 0.9995 of a token
    expect(b.take('a')).toBe(false);
    t += 2; // 1.0005
    expect(b.take('a')).toBe(true);
  });
});

describe('envNumber', () => {
  it('clamps, and falls back on unset, blank or non-finite values', () => {
    expect(envNumber(undefined, 7, 0, 10)).toBe(7);
    expect(envNumber('  ', 7, 0, 10)).toBe(7);
    expect(envNumber('abc', 7, 0, 10)).toBe(7);
    expect(envNumber('Infinity', 7, 0, 10)).toBe(7);
    expect(envNumber('99', 7, 0, 10)).toBe(10);
    expect(envNumber('-1', 7, 0, 10)).toBe(0);
    expect(envNumber(' 2.5 ', 7, 0, 10)).toBe(2.5);
  });
});
