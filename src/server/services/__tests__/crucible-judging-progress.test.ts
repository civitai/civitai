import { describe, expect, it } from 'vitest';
import { countRemainingPairs } from '~/server/services/crucible.service';

const CAP = 5;
const count = (
  entryIds: number[],
  { votes = {}, voted = [] }: { votes?: Record<number, number>; voted?: string[] } = {}
) =>
  countRemainingPairs({
    entryIds,
    judgeEntryVotes: Object.fromEntries(Object.entries(votes).map(([id, n]) => [id, String(n)])),
    votedPairKeys: voted,
    maxVotesPerEntry: CAP,
  });

describe('countRemainingPairs', () => {
  it('counts every pair when the judge has voted on none', () => {
    expect(count([1, 2, 3, 4])).toBe(6);
  });

  it('takes away the pairs the judge already voted', () => {
    expect(count([1, 2, 3, 4], { voted: ['1:2', '3:4'] })).toBe(4);
  });

  it('ignores voted pairs involving an entry the judge can no longer see', () => {
    expect(count([1, 2, 3], { voted: ['1:9'] })).toBe(3);
  });

  it('leaves out an entry the judge has voted on as often as allowed', () => {
    expect(count([1, 2, 3, 4], { votes: { 1: CAP } })).toBe(3);
  });

  it('never counts more pairs than the votes left on the entries allow', () => {
    // Three entries with one vote left each: at most one more pair, though three are unjudged.
    expect(count([1, 2, 3], { votes: { 1: CAP - 1, 2: CAP - 1, 3: CAP - 1 } })).toBe(1);
  });

  it('is zero with fewer than two entries to judge', () => {
    expect(count([])).toBe(0);
    expect(count([1])).toBe(0);
  });
});
