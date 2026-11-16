import { describe, expect, it } from 'vitest';
import { gaugeFraction, nextRankRequirements, pendingSegment, xpLine } from './gauge';

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

  it('says reached when the count alone clears the bar, as the met flag does', () => {
    const counted = {
      ...status,
      nextRank: { ...status.nextRank, minDaysPlayed: 50, daysPlayed: 60 },
    };
    expect(nextRankRequirements(counted, []).at(-1)).toEqual({
      key: 'days',
      text: 'At least 50 days played · reached',
      met: true,
    });
  });

  it('is empty at the top of the ladder', () => {
    expect(nextRankRequirements({ ...status, nextRank: null }, [])).toEqual([]);
  });
});

describe('pendingSegment', () => {
  it('puts pending XP right after the confirmed fill', () => {
    const seg = pendingSegment(876, 5163, 360);
    expect(seg.confirmed).toBeCloseTo(876 / 5163);
    expect(seg.pending).toBeCloseTo(360 / 5163);
    expect(seg.overflow).toBe(0);
  });

  it('is empty with nothing pending, and survives a level with no XP to give', () => {
    expect(pendingSegment(100, 1000, 0)).toMatchObject({ pending: 0, overflow: 0 });
    expect(pendingSegment(100, 0, 90)).toEqual({ confirmed: 0, pending: 0, overflow: 0 });
    expect(pendingSegment(100, 1000, -5).pending).toBe(0);
  });

  it('fills to the end of the level and reports what spills past it, without a level-up', () => {
    const seg = pendingSegment(900, 1000, 360);
    expect(seg.confirmed).toBeCloseTo(0.9);
    expect(seg.pending).toBeCloseTo(0.1);
    expect(seg.confirmed + seg.pending).toBeCloseTo(1);
    expect(seg.overflow).toBe(260);
  });
});

describe('xpLine', () => {
  it('reads confirmed XP, then what is pending', () => {
    expect(xpLine(876, 5163, 360)).toBe('876 / 5,163 XP · +360 pending');
    expect(xpLine(876, 5163, 0)).toBe('876 / 5,163 XP');
  });
});
