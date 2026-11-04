import { describe, expect, it } from 'vitest';
import { gaugeFraction, nextRankRequirements } from './gauge';

describe('gaugeFraction', () => {
  it('is the share of the level earned', () => {
    expect(gaugeFraction(640, 1000)).toBeCloseTo(0.64);
    expect(gaugeFraction(0, 1000)).toBe(0);
  });

  it('stays inside 0..1 and survives a level with no XP to give', () => {
    expect(gaugeFraction(1200, 1000)).toBe(1);
    expect(gaugeFraction(-5, 1000)).toBe(0);
    expect(gaugeFraction(10, 0)).toBe(0);
  });
});

describe('nextRankRequirements', () => {
  const status = {
    level: 12,
    rating: { accuracy: 0.82 },
    nextRank: {
      rank: 'Templar',
      fromLevel: 21,
      accuracyBar: 0.8,
      levelsToGo: 9,
      levelMet: false,
      accuracyMet: true,
    },
  };

  it('lists level and accuracy, each with where the player stands', () => {
    expect(nextRankRequirements(status, [])).toEqual([
      { key: 'level', text: 'Level 21 · 9 levels to go', met: false },
      { key: 'accuracy', text: 'Accuracy 80%+ · you are at 82%', met: true },
    ]);
  });

  it('says so when accuracy is not yet rated', () => {
    const unrated = { ...status, rating: { accuracy: null } };
    expect(nextRankRequirements(unrated, [])[1].text).toBe('Accuracy 80%+ · not yet rated');
  });

  it('adds days played only when the rank asks for it in config', () => {
    const ladder = [{ rank: 'Templar', fromLevel: 21, accuracyBar: 0.8, minDaysPlayed: 60 }];
    expect(nextRankRequirements(status, ladder).at(-1)).toEqual({
      key: 'days',
      text: 'At least 60 days played',
      met: null,
    });
  });

  it('shows the real days played and whether the bar is met when the status carries them', () => {
    const withDays = (daysPlayed: number, daysMet: boolean) => ({
      ...status,
      nextRank: { ...status.nextRank, minDaysPlayed: 50, daysPlayed, daysMet },
    });
    expect(nextRankRequirements(withDays(32, false), []).at(-1)).toEqual({
      key: 'days',
      text: 'At least 50 days played · you have 32',
      met: false,
    });
    expect(nextRankRequirements(withDays(50, true), []).at(-1)?.text).toBe(
      'At least 50 days played · reached'
    );
  });

  it('is empty at the top of the ladder', () => {
    expect(nextRankRequirements({ ...status, nextRank: null }, [])).toEqual([]);
  });
});
