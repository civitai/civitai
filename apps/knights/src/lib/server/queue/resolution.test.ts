import { describe, expect, it } from 'vitest';
import {
  decideChoice,
  isBlockedLevel,
  isExcessiveDownRating,
  levelForExp,
  voteWeight,
} from './resolution';

const rule = { votesNeeded: 5, maxVotes: 10, threshold: 0.6 };
const votes = (answers: string[], weight = 1) => answers.map((answer) => ({ answer, weight }));

describe('decideChoice', () => {
  it('waits below the votes needed even when the votes agree', () => {
    expect(decideChoice(votes(['4', '4', '4', '4']), rule)).toEqual({ kind: 'pending' });
  });

  it('resolves to the answer holding at least the threshold of the weighted vote', () => {
    expect(decideChoice(votes(['4', '4', '4', '2', '8']), rule)).toEqual({
      kind: 'resolved',
      value: '4',
    });
  });

  it('counts weight, not heads: one heavy vote can carry a split count', () => {
    const mixed = [...votes(['8', '8'], 1), ...votes(['4', '4'], 1), { answer: '4', weight: 3 }];
    expect(decideChoice(mixed, rule)).toEqual({ kind: 'resolved', value: '4' });
  });

  it('stays open on a split below the maximum', () => {
    expect(decideChoice(votes(['1', '2', '4', '8', '16']), rule)).toEqual({ kind: 'pending' });
  });

  it('asks to escalate a split once the maximum is reached', () => {
    const split = votes(['1', '2', '4', '8', '16', '1', '2', '4', '8', '16']);
    expect(decideChoice(split, rule)).toEqual({ kind: 'split' });
  });

  it('still resolves at the maximum when a late vote tips it over', () => {
    const late = votes(['1', '1', '2', '2', '4', '4', '4', '4', '4', '4']);
    expect(decideChoice(late, rule)).toEqual({ kind: 'resolved', value: '4' });
  });

  it('never resolves on zero total weight', () => {
    expect(decideChoice(votes(['4', '4', '4', '4', '4'], 0), rule)).toEqual({ kind: 'pending' });
  });
});

describe('isExcessiveDownRating', () => {
  it('allows one level down, up, or the same', () => {
    expect(isExcessiveDownRating(8, 4)).toBe(false);
    expect(isExcessiveDownRating(8, 16)).toBe(false);
    expect(isExcessiveDownRating(8, 8)).toBe(false);
  });

  it('flags more than one level below the current rating', () => {
    expect(isExcessiveDownRating(16, 4)).toBe(true);
    expect(isExcessiveDownRating(8, 1)).toBe(true);
  });
});

describe('isBlockedLevel', () => {
  it('is true only for Blocked', () => {
    expect(isBlockedLevel(32)).toBe(true);
    expect([1, 2, 4, 8, 16].some(isBlockedLevel)).toBe(false);
  });
});

describe('levelForExp', () => {
  it('follows the 250 xp base growing 18% a level', () => {
    expect(levelForExp(0)).toBe(1);
    expect(levelForExp(249)).toBe(1);
    expect(levelForExp(250)).toBe(2);
    expect(levelForExp(250 + 295)).toBe(3);
  });
});

describe('voteWeight', () => {
  it('is zero for an Acolyte whatever the level', () => {
    expect(voteWeight({ rank: 'Acolyte', level: 30, smites: 0 })).toBe(0);
  });

  it('starts from the rank and moves with level and smites', () => {
    expect(voteWeight({ rank: 'Knight', level: 20, smites: 0 })).toBe(1);
    expect(voteWeight({ rank: 'Templar', level: 20, smites: 0 })).toBe(1.5);
    expect(voteWeight({ rank: 'Knight', level: 80, smites: 0 })).toBe(2);
    expect(voteWeight({ rank: 'Knight', level: 20, smites: 3 })).toBe(0.5);
  });

  it('never goes below zero', () => {
    expect(voteWeight({ rank: 'Knight', level: 20, smites: 12 })).toBe(0);
  });
});

describe('voteWeight below the accuracy bar', () => {
  it('is halved by the config factor', async () => {
    const { RATING } = await import('../progression/config');
    const base = voteWeight({ rank: 'Templar', level: 20, smites: 0 });
    expect(voteWeight({ rank: 'Templar', level: 20, smites: 0, belowBar: true })).toBe(
      Math.round(base * RATING.belowBarFactor * 100) / 100
    );
  });
});
