import { describe, expect, it } from 'vitest';
import { decidedPairKeys, impliedPairKeys } from '~/server/services/crucible-judge-closure';
import { fitBradleyTerry } from '~/server/services/crucible-bradley-terry';

const sorted = (keys: Iterable<string>) => [...keys].sort();

describe('impliedPairKeys', () => {
  it('decides A-C from A>B and B>C', () => {
    expect(impliedPairKeys(['1>2', '2>3']).has('1:3')).toBe(true);
  });

  it('follows a chain of any length', () => {
    expect(sorted(impliedPairKeys(['1>2', '2>3', '3>4']))).toEqual(
      sorted(['1:2', '1:3', '1:4', '2:3', '2:4', '3:4'])
    );
  });

  it('decides nothing two losses to one winner do not settle', () => {
    // 1>2 and 1>3 say nothing about 2 against 3.
    expect(impliedPairKeys(['1>2', '1>3']).has('2:3')).toBe(false);
  });

  // Deliberate: a pair the judge's own votes reach both ways is a contradiction, and serving it
  // again is how it gets resolved. Do not "simplify" this into skipping every pair in a cycle.
  it('leaves a pair the votes reach both ways undecided', () => {
    const implied = impliedPairKeys(['1>2', '2>3', '3>4', '4>1']);
    expect(implied.has('1:3')).toBe(false);
    expect(implied.has('2:4')).toBe(false);
  });

  it('ignores a malformed outcome instead of throwing', () => {
    expect(sorted(impliedPairKeys(['1:2', 'x>y', '3>3', '1>2']))).toEqual(['1:2']);
  });
});

describe('decidedPairKeys', () => {
  it('keeps every directly voted pair, including those inside a contradiction', () => {
    const decided = decidedPairKeys(['1:2', '2:3', '1:3'], ['1>2', '2>3', '3>1']);
    expect(sorted(decided)).toEqual(['1:2', '1:3', '2:3']);
  });

  it('is the voted pairs alone when no outcomes are stored (votes cast before the skip)', () => {
    expect(decidedPairKeys(['1:2', '2:3'], [])).toEqual(['1:2', '2:3']);
  });
});

describe('fitBradleyTerry', () => {
  it('orders a consistent set of votes the way they point', () => {
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 3 },
      { winnerEntryId: 2, loserEntryId: 3, votes: 3 },
      { winnerEntryId: 1, loserEntryId: 3, votes: 1 },
    ]);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
    expect(scores.get(2)!).toBeGreaterThan(scores.get(3)!);
  });

  it('keeps an entry that never lost finite', () => {
    const scores = fitBradleyTerry([{ winnerEntryId: 1, loserEntryId: 2, votes: 50 }]);
    expect(Number.isFinite(scores.get(1))).toBe(true);
    expect(scores.get(1)! - scores.get(2)!).toBeLessThan(1200);
  });

  it('centres on 1500 and scores an even split level', () => {
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 4 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 4 },
    ]);
    expect(scores.get(1)).toBe(1500);
    expect(scores.get(2)).toBe(1500);
  });

  it('ranks by who was beaten, not by raw wins: beating the strongest counts for more', () => {
    // 3 is strong (beats 4 and 5 often). 1 beats 3 once; 2 beats only weak 5, twice.
    const scores = fitBradleyTerry([
      { winnerEntryId: 3, loserEntryId: 4, votes: 5 },
      { winnerEntryId: 3, loserEntryId: 5, votes: 5 },
      { winnerEntryId: 1, loserEntryId: 3, votes: 1 },
      { winnerEntryId: 2, loserEntryId: 5, votes: 2 },
    ]);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
  });

  it('scores nothing without votes', () => {
    expect(fitBradleyTerry([]).size).toBe(0);
  });
});
