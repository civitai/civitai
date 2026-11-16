import { describe, expect, it } from 'vitest';
import { DAILY } from './daily/config';
import { PROGRESSION, RANK_LADDER } from './progression/config';
import { badgeStreaksOf, rulesFacts } from './rules';
import { SMITES } from './smites/config';
import { APPRENTICE } from './apprenticeship/config';

describe('rulesFacts', () => {
  it('quotes the numbers the game runs on', () => {
    const facts = rulesFacts();
    expect(facts.apprenticeship.knightLevel).toBe(APPRENTICE.knightLevel);
    expect(facts.apprenticeship.accuracyPercent).toBe(APPRENTICE.accuracyBar * 100);
    expect(facts.watch.size).toBe(DAILY.watchSize);
    expect(facts.ranks.map((r) => r.rank)).toEqual(RANK_LADDER.map((r) => r.rank));
  });

  it('quotes the level bands and the days played from the ladder', () => {
    expect(rulesFacts().ranks).toEqual([
      { rank: 'Knight', levels: '20–49', accuracyPercent: 70, minDaysPlayed: 0 },
      { rank: 'Templar', levels: '50–89', accuracyPercent: 80, minDaysPlayed: 0 },
      { rank: 'Paladin', levels: '90+', accuracyPercent: 85, minDaysPlayed: 60 },
    ]);
  });

  it('starts the Knight band where the apprenticeship ends', () => {
    expect(RANK_LADDER[0].fromLevel).toBe(APPRENTICE.knightLevel);
  });

  it('quotes the hearts and how long a lost one takes to return, from the smite config', () => {
    expect(rulesFacts().hearts).toEqual({
      max: SMITES.max,
      returnAfterDays: SMITES.expireAfterDays,
    });
  });

  it('quotes the daily gold caps and the Vigil streaks from config', () => {
    const facts = rulesFacts();
    expect(facts.gold.dailyCap).toEqual({
      firstLevel: 20,
      first: 80_000,
      topLevel: 130,
      top: 400_000,
    });
    expect(facts.watch.badgeStreaks).toEqual([7, 30, 100]);
  });

  it('promises a Vigil badge only for a milestone whose badge exists', () => {
    expect(badgeStreaksOf({ 7: 1, 30: null, 100: 3 })).toEqual([7, 100]);
  });

  it('keeps behind-the-scenes numbers out of the facts', () => {
    expect(rulesFacts()).not.toHaveProperty('yesNo');
  });

  it('keeps a vote worth its immediate and graded XP together', () => {
    const { xp } = rulesFacts();
    expect(xp.atVote + xp.onCorrect).toBe(100);
  });

  it('quotes the fervor formula from config, so the page never names a scale itself', () => {
    expect(rulesFacts().fervor).toEqual({
      scale: PROGRESSION.fervorScale,
      windowDays: PROGRESSION.fervorWindowDays,
      accuracyFloorPercent: PROGRESSION.fervorAccuracyFloor * 100,
    });
  });

  it('guides all six rating levels, Blocked last', () => {
    const labels = rulesFacts().ratingGuide.map((g) => g.label);
    expect(labels).toEqual(['PG', 'PG-13', 'R', 'X', 'XXX', 'Blocked']);
    expect(rulesFacts().ratingGuide.every((g) => g.description.length > 0)).toBe(true);
  });
});
