import { describe, expect, it } from 'vitest';
import { PROGRESSION, RANK_LADDER, RATING } from './config';
import { accuracyOf, earnedRank, rankTable, standingOf } from './rating';

const rated = (correct: number, failed: number) => ({ correct, graded: correct + failed });

describe('accuracyOf', () => {
  it('is not rated below the minimum sample', () => {
    expect(accuracyOf(rated(RATING.minGraded - 1, 0))).toBeNull();
    expect(accuracyOf({ correct: 0, graded: 0 })).toBeNull();
  });

  it('is correct over graded once the sample is met', () => {
    expect(accuracyOf(rated(40, 10))).toBe(0.8);
  });
});

describe('standingOf', () => {
  it('has no bar for ranks without one', () => {
    expect(standingOf('Acolyte', rated(0, 100))).toMatchObject({ bar: null, belowBar: false });
    expect(standingOf('Inquisitor', rated(0, 100))).toMatchObject({ bar: null, belowBar: false });
  });

  it('is below the bar only when rated and under it', () => {
    expect(standingOf('Knight', rated(0, 10))).toMatchObject({ accuracy: null, belowBar: false });
    expect(standingOf('Knight', rated(34, 16))).toMatchObject({ bar: 0.7, belowBar: true });
    expect(standingOf('Knight', rated(35, 15))).toMatchObject({ belowBar: false });
    expect(standingOf('Paladin', rated(42, 8))).toMatchObject({ bar: 0.85, belowBar: true });
  });
});

describe('earnedRank', () => {
  const good = 0.9;

  it('needs the level and the accuracy bar', () => {
    expect(earnedRank('Knight', 25, null)).toBeNull();
    expect(earnedRank('Knight', 25, 0.79)).toBeNull();
    expect(earnedRank('Knight', 20, good)).toBeNull();
    expect(earnedRank('Knight', 21, 0.8)).toBe('Templar');
  });

  it('skips ranks when both bars are met', () => {
    expect(earnedRank('Knight', 45, good)).toBe('Paladin');
    expect(earnedRank('Knight', 45, 0.82)).toBe('Templar');
    expect(earnedRank('Templar', 41, 0.85)).toBe('Paladin');
  });

  it('never moves a rank down, nor touches Acolytes, Inquisitors or Paladins', () => {
    expect(earnedRank('Paladin', 60, good)).toBeNull();
    expect(earnedRank('Acolyte', 60, good)).toBeNull();
    expect(earnedRank('Inquisitor', 60, good)).toBeNull();
  });
});

describe('rankTable', () => {
  it('lists every ladder rank with its levels, bar, weight and gold from config', () => {
    expect(rankTable()).toEqual([
      { rank: 'Knight', levels: '1–20', accuracyBar: 0.7, voteWeight: 1, goldMultiplier: 1 },
      { rank: 'Templar', levels: '21–40', accuracyBar: 0.8, voteWeight: 1.5, goldMultiplier: 1.25 },
      { rank: 'Paladin', levels: '41+', accuracyBar: 0.85, voteWeight: 2, goldMultiplier: 1.5 },
    ]);
    expect(rankTable().map((r) => r.rank)).toEqual(RANK_LADDER.map((r) => r.rank));
    expect(PROGRESSION.baseGold).toBeGreaterThan(0);
  });
});
