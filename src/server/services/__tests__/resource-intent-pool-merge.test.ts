import { describe, expect, it } from 'vitest';

import { poolMergeModelIds } from '~/server/services/resource-intent-pool-merge';

/**
 * The POOL_MERGE list, both shapes. With a baseModel gate (`interleaveBase: true`) BASE interleaves
 * with the co-occurrence models, as the screen measured. Without one, BASE is global popularity, so
 * it only backfills after the co-occurrence list. Every expected list is a literal.
 */

// 9 first, a duplicate 2, and 1 and 7 also on BASE.
const COOC = [9, 1, 2, 2, 3, 7];
const BASE = [1, 4, 5, 6, 7, 8, 10, 11];

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe('no baseModel gate: co-occurrence first, BASE only backfills', () => {
  const noBm = (cooc: number[], base: number[], cap: number) =>
    poolMergeModelIds(cooc, base, cap, { interleaveBase: false });

  it('keeps the co-occurrence order, then BASE minus what is already listed', () => {
    expect(noBm(COOC, BASE, 50)).toEqual([9, 1, 2, 3, 7, 4, 5, 6, 8, 10, 11]);
  });

  it('a narrower cap is the prefix', () => {
    expect(noBm(COOC, BASE, 4)).toEqual([9, 1, 2, 3]);
    expect(noBm(COOC, BASE, 7)).toEqual([9, 1, 2, 3, 7, 4, 5]);
  });

  it('a co-occurrence list longer than 25 keeps all of its models ahead of BASE', () => {
    const cooc = range(1000, 30);
    const base = range(2000, 100);
    expect(noBm(cooc, base, 50)).toEqual([...range(1000, 30), ...range(2000, 20)]);
  });

  it('a co-occurrence list of 50 or more leaves BASE no slot', () => {
    expect(noBm(range(1000, 60), range(2000, 100), 50)).toEqual(range(1000, 50));
  });

  it('a cap above 50 still returns the 50-wide list', () => {
    expect(noBm(range(1000, 30), range(2000, 100), 120)).toEqual([
      ...range(1000, 30),
      ...range(2000, 20),
    ]);
  });

  it('no co-occurrence models: BASE alone, deduplicated', () => {
    expect(noBm([], [4, 5, 4, 6], 50)).toEqual([4, 5, 6]);
    expect(noBm([], range(2000, 100), 50)).toEqual(range(2000, 50));
  });
});

describe('with a baseModel gate: interleaved exactly as before', () => {
  const withBm = (cooc: number[], base: number[], cap: number) =>
    poolMergeModelIds(cooc, base, cap, { interleaveBase: true });

  it('interleaves co-occurrence first with BASE minus the reserved models', () => {
    expect(withBm(COOC, BASE, 50)).toEqual([9, 4, 1, 5, 2, 6, 3, 8, 7, 10, 11]);
    expect(withBm(COOC, BASE, 4)).toEqual([9, 4, 1, 5]);
  });

  it('reserves at most 25 co-occurrence slots, and a cap above 50 gets the 50', () => {
    const expected = range(0, 25).flatMap((i) => [1000 + i, 2000 + i]);
    expect(withBm(range(1000, 30), range(2000, 100), 50)).toEqual(expected);
    expect(withBm(range(1000, 30), range(2000, 100), 120)).toEqual(expected);
  });

  it('no co-occurrence models: BASE alone', () => {
    expect(withBm([], range(2000, 100), 50)).toEqual(range(2000, 50));
  });
});
