import { describe, expect, it } from 'vitest';
import {
  countJudgedPairs,
  countRemainingPairs,
  countUnjudgedRemainingPairs,
} from '~/server/services/crucible.service';

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

  it('counts an entry the judge has voted on as often as allowed only as an anchor', () => {
    // 2:3, 2:4, 3:4, plus each of them against anchor 1.
    expect(count([1, 2, 3, 4], { votes: { 1: CAP } })).toBe(6);
  });

  it('never counts a pair of two anchors', () => {
    expect(count([1, 2, 3], { votes: { 1: CAP, 2: CAP } })).toBe(2);
    expect(count([1, 2], { votes: { 1: CAP, 2: CAP } })).toBe(0);
  });

  it('takes away anchor pairs the judge already voted', () => {
    expect(count([1, 2, 3], { votes: { 1: CAP, 2: CAP }, voted: ['1:3'] })).toBe(1);
  });

  it('ignores a voted pair between two anchors', () => {
    expect(count([1, 2, 3], { votes: { 1: CAP, 2: CAP }, voted: ['1:2'] })).toBe(2);
  });

  it('takes away a voted open pair while counting anchor pairs', () => {
    expect(count([1, 2, 3, 4], { votes: { 1: CAP }, voted: ['2:3'] })).toBe(5);
  });

  it('bounds anchor pairs by each entry, not by the votes left overall', () => {
    // Entry 3 has one vote left; entry 4 has five but has met both anchors and entry 3 already.
    const voted = ['1:4', '2:4', '3:4'];
    expect(count([1, 2, 3, 4], { votes: { 1: CAP, 2: CAP, 3: CAP - 1 }, voted })).toBe(1);
  });

  it('leaves no open pairs once anchor pairs take the votes left', () => {
    expect(count([1, 2, 3], { votes: { 1: CAP, 2: CAP - 1, 3: CAP - 1 } })).toBe(2);
  });

  it('spends one vote on an anchor pair, not two', () => {
    // Entry 2 has one vote left: one more pair, against either anchor.
    expect(count([1, 2, 3], { votes: { 1: CAP, 2: CAP - 1, 3: CAP } })).toBe(1);
  });

  it('counts the pair a first vote opens up by turning entries into anchors', () => {
    // Three entries with one vote left each: 1:2 uses both up, and 3 can then face either one.
    expect(count([1, 2, 3], { votes: { 1: CAP - 1, 2: CAP - 1, 3: CAP - 1 } })).toBe(2);
  });

  it('never counts more pairs than the votes left on the entries allow', () => {
    // One vote left on each of two entries and no anchor: their pair spends both.
    expect(count([1, 2], { votes: { 1: CAP - 1, 2: CAP - 1 } })).toBe(1);
    // With an anchor each can spend its last vote on it instead.
    expect(count([1, 2, 3], { votes: { 1: CAP - 1, 2: CAP - 1, 3: CAP } })).toBe(2);
  });

  // Plays the judge out with the matchmaker's own rules, so the count is checked against what can
  // actually be served rather than against a hand calculation.
  it.each([
    { entries: 3, left: [1, 1, 1] },
    { entries: 4, left: [5, 5, 5, 5] },
    { entries: 5, left: [1, 2, 1, 3, 0] },
    { entries: 6, left: [2, 0, 0, 1, 1, 4] },
  ])('matches what a judge can be served: %o', ({ entries, left }) => {
    const ids = Array.from({ length: entries }, (_, i) => i + 1);
    const votes = Object.fromEntries(ids.map((id, i) => [id, CAP - left[i]]));
    const expected = count(ids, { votes });

    const remaining = new Map(ids.map((id, i) => [id, left[i]]));
    const voted = new Set<string>();
    let served = 0;
    // Greedy over pairs, an anchor first wherever one is free: it spends one vote, not two.
    for (let progress = true; progress; ) {
      progress = false;
      const open = ids.filter((id) => remaining.get(id)! > 0);
      const anchors = ids.filter((id) => remaining.get(id)! <= 0);
      for (const a of open) {
        const b =
          anchors.find((x) => !voted.has(`${Math.min(a, x)}:${Math.max(a, x)}`)) ??
          open.find((x) => x !== a && !voted.has(`${Math.min(a, x)}:${Math.max(a, x)}`));
        if (b === undefined) continue;
        voted.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        for (const id of [a, b])
          if (remaining.get(id)! > 0) remaining.set(id, remaining.get(id)! - 1);
        served++;
        progress = true;
        break;
      }
    }

    expect(expected, 'counted against served').toBe(served);
  });

  it('is zero with fewer than two entries to judge', () => {
    expect(count([])).toBe(0);
    expect(count([1])).toBe(0);
  });
});

describe('countJudgedPairs', () => {
  it('counts voted pairs whose entries are both visible', () => {
    expect(countJudgedPairs({ entryIds: [1, 2, 3], votedPairKeys: ['1:2', '2:3'] })).toBe(2);
  });

  it('skips pairs touching a hidden or removed entry', () => {
    expect(countJudgedPairs({ entryIds: [1, 2], votedPairKeys: ['1:2', '2:9', '8:9'] })).toBe(1);
  });

  it('is zero when nothing was voted', () => {
    expect(countJudgedPairs({ entryIds: [1, 2], votedPairKeys: [] })).toBe(0);
  });
});

describe('countUnjudgedRemainingPairs', () => {
  it('matches countRemainingPairs with no votes', () => {
    for (const maxVotesPerEntry of [1, 2, 5]) {
      for (let n = 0; n <= 30; n++) {
        const expected = countRemainingPairs({
          entryIds: Array.from({ length: n }, (_, i) => i + 1),
          judgeEntryVotes: {},
          votedPairKeys: [],
          maxVotesPerEntry,
        });
        expect([n, maxVotesPerEntry, countUnjudgedRemainingPairs(n, maxVotesPerEntry)]).toEqual([
          n,
          maxVotesPerEntry,
          expected,
        ]);
      }
    }
  });
});
