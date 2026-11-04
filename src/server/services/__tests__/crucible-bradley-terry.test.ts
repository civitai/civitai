import { describe, expect, it } from 'vitest';
import { fitBradleyTerry } from '~/server/services/crucible-bradley-terry';

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

  it('ranks the same however the votes are ordered', () => {
    const tallies = [
      { winnerEntryId: 1, loserEntryId: 2, votes: 3 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 1 },
      { winnerEntryId: 2, loserEntryId: 3, votes: 2 },
      { winnerEntryId: 3, loserEntryId: 4, votes: 4 },
      { winnerEntryId: 4, loserEntryId: 1, votes: 1 },
      { winnerEntryId: 1, loserEntryId: 5, votes: 2 },
    ];
    const expected = [...fitBradleyTerry(tallies)].sort(([a], [b]) => a - b);
    for (const shuffled of [[...tallies].reverse(), [3, 0, 5, 1, 4, 2].map((i) => tallies[i])]) {
      expect([...fitBradleyTerry(shuffled)].sort(([a], [b]) => a - b)).toEqual(expected);
    }
  });

  it('maps onto the Elo scale: 400 points apart means 10-to-1 odds', () => {
    // 10 wins to 1 between two entries; the prior adds one each way against a level opponent, so
    // the gap lands a little under 400.
    const scores = fitBradleyTerry([
      { winnerEntryId: 1, loserEntryId: 2, votes: 100 },
      { winnerEntryId: 2, loserEntryId: 1, votes: 10 },
    ]);
    expect(scores.get(1)! + scores.get(2)!).toBe(3000);
    expect(scores.get(1)! - scores.get(2)!).toBeGreaterThan(370);
    expect(scores.get(1)! - scores.get(2)!).toBeLessThan(400);
  });

  it('scores nothing without votes', () => {
    expect(fitBradleyTerry([]).size).toBe(0);
  });
});
