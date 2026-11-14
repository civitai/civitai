import { describe, expect, it } from 'vitest';
import { PROGRESSION, RANK_LADDER, RATING } from './config';
import {
  accuracyOf,
  earnedRank,
  nextLadderEntry,
  progressToward,
  rankTable,
  standingOf,
} from './rating';

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
  const veteran = 365;

  it('needs the level and the accuracy bar', () => {
    expect(earnedRank('Knight', 60, null, veteran)).toBeNull();
    expect(earnedRank('Knight', 60, 0.79, veteran)).toBeNull();
    expect(earnedRank('Knight', 49, good, veteran)).toBeNull();
    expect(earnedRank('Knight', 50, 0.8, veteran)).toBe('Templar');
  });

  it('skips ranks when both bars are met', () => {
    expect(earnedRank('Knight', 95, good, veteran)).toBe('Paladin');
    expect(earnedRank('Knight', 95, 0.82, veteran)).toBe('Templar');
    expect(earnedRank('Templar', 90, 0.85, veteran)).toBe('Paladin');
  });

  it('holds back Paladin until the player has played enough days', () => {
    expect(earnedRank('Templar', 90, good, 59)).toBeNull();
    expect(earnedRank('Templar', 90, good, 60)).toBe('Paladin');
    expect(earnedRank('Knight', 95, good, 59)).toBe('Templar');
  });

  it('never moves a rank down, nor touches Acolytes, Inquisitors or Paladins', () => {
    expect(earnedRank('Paladin', 120, good, veteran)).toBeNull();
    expect(earnedRank('Acolyte', 120, good, veteran)).toBeNull();
    expect(earnedRank('Inquisitor', 120, good, veteran)).toBeNull();
  });
});

describe('rankTable', () => {
  it('lists every ladder rank with its levels, bar, weight and gold from config', () => {
    expect(rankTable()).toEqual([
      {
        rank: 'Knight',
        levels: '20–49',
        accuracyBar: 0.7,
        minDaysPlayed: 0,
        voteWeight: 1,
        goldMultiplier: 1,
        dailyGoldCap: { from: 80_000, to: 120_000 },
      },
      {
        rank: 'Templar',
        levels: '50–89',
        accuracyBar: 0.8,
        minDaysPlayed: 0,
        voteWeight: 1.5,
        goldMultiplier: 1.25,
        dailyGoldCap: { from: 140_000, to: 180_000 },
      },
      {
        rank: 'Paladin',
        levels: '90+',
        accuracyBar: 0.85,
        minDaysPlayed: 60,
        voteWeight: 2,
        goldMultiplier: 1.5,
        dailyGoldCap: { from: 200_000, to: 400_000 },
      },
    ]);
    expect(rankTable().map((r) => r.rank)).toEqual(RANK_LADDER.map((r) => r.rank));
    expect(PROGRESSION.baseGold).toBeGreaterThan(0);
  });
});

describe('nextLadderEntry', () => {
  it('names the next rank only for ranks on the ladder', () => {
    expect(nextLadderEntry('Knight')?.rank).toBe('Templar');
    expect(nextLadderEntry('Templar')?.rank).toBe('Paladin');
    expect(nextLadderEntry('Paladin')).toBeNull();
    expect(nextLadderEntry('Acolyte')).toBeNull();
    expect(nextLadderEntry('Inquisitor')).toBeNull();
  });
});

describe('progressToward', () => {
  const [, templar, paladin] = RANK_LADDER;

  it('says how many levels are left and which requirements are met', () => {
    expect(progressToward(templar, 48, 0.9, 0)).toEqual({
      levelsToGo: 2,
      levelMet: false,
      accuracyMet: true,
      daysToGo: 0,
      daysMet: true,
    });
    expect(progressToward(templar, 50, 0.79, 0)).toMatchObject({
      levelsToGo: 0,
      levelMet: true,
      accuracyMet: false,
    });
    expect(progressToward(templar, 50, null, 0).accuracyMet).toBe(false);
  });

  it('counts the days still to play for a rank that asks for them', () => {
    expect(progressToward(paladin, 90, 0.9, 45)).toMatchObject({ daysToGo: 15, daysMet: false });
    expect(progressToward(paladin, 90, 0.9, 60)).toMatchObject({ daysToGo: 0, daysMet: true });
    expect(progressToward(paladin, 90, 0.9, 200)).toMatchObject({ daysToGo: 0, daysMet: true });
  });
});
