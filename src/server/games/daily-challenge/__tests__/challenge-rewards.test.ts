import { describe, it, expect } from 'vitest';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { selectPayableUsers } from '~/server/games/daily-challenge/challenge-rewards';

describe('parseChallengeMetadata reconciliation', () => {
  it('round-trips the reconciliation field', () => {
    const parsed = parseChallengeMetadata({
      reconciliation: { paidUserIds: [1, 2], lastRunAt: '2026-06-23T05:00:00.000Z', done: false },
    });
    expect(parsed.reconciliation?.paidUserIds).toEqual([1, 2]);
    expect(parsed.reconciliation?.done).toBe(false);
  });

  it('defaults reconciliation to undefined when absent', () => {
    expect(parseChallengeMetadata({ themeElements: ['a'] }).reconciliation).toBeUndefined();
  });
});

describe('selectPayableUsers', () => {
  it('removes excluded users (winners ∪ already-paid)', () => {
    expect(selectPayableUsers([1, 2, 3, 4], [2, 4])).toEqual([1, 3]);
  });
  it('returns empty when all excluded', () => {
    expect(selectPayableUsers([1, 2], [1, 2, 3])).toEqual([]);
  });
  it('de-duplicates qualifiers', () => {
    expect(selectPayableUsers([1, 1, 2], [])).toEqual([1, 2]);
  });
});
