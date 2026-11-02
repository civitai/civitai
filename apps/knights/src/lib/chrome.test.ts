import { describe, expect, it } from 'vitest';
import {
  accuracyLine,
  heartsLeft,
  nextRankLine,
  rankPill,
  restartLosses,
  smiteHeading,
  watchStrip,
} from './chrome';

const daily = { votes: 5, watchSize: 10, watchDone: false, bonusGold: 500, capReached: false };

describe('rankPill', () => {
  it('names the rank and level', () => {
    expect(rankPill({ rank: 'Knight', level: 12 })).toBe('Knight · Lv 12');
  });
});

describe('heartsLeft', () => {
  it('is what the smites leave, never below zero', () => {
    expect(heartsLeft({ smites: 1, maxSmites: 3 })).toBe(2);
    expect(heartsLeft({ smites: 5, maxSmites: 3 })).toBe(0);
  });
});

describe('watchStrip', () => {
  it('shows progress and the bonus still to earn', () => {
    expect(watchStrip(daily)).toEqual({
      label: "Today's Watch · 5 of 10",
      value: 5,
      max: 10,
      note: '+500 gold at the end',
    });
  });

  it('never counts past the Watch size', () => {
    expect(watchStrip({ ...daily, votes: 14 })).toMatchObject({
      label: "Today's Watch · 10 of 10",
      value: 10,
    });
  });

  it('says so once the Watch is done', () => {
    expect(watchStrip({ ...daily, votes: 10, watchDone: true }).note).toBe(
      'Complete · +500 gold earned'
    );
  });

  it('says the gold cap is reached, and that XP still counts', () => {
    expect(watchStrip({ ...daily, capReached: true }).note).toBe(
      'Gold cap reached · XP still counts'
    );
  });

  it('formats a large bonus with separators', () => {
    expect(watchStrip({ ...daily, bonusGold: 1500 }).note).toBe('+1,500 gold at the end');
  });
});

const standing = (over: Record<string, unknown> = {}) =>
  ({
    rank: 'Knight',
    level: 12,
    exp: 640,
    goldEarned: 3200,
    goldPending: 500,
    rating: { accuracy: 0.82, bar: 0.7, belowBar: false, graded: 80, minGraded: 50 },
    nextRank: {
      rank: 'Templar',
      fromLevel: 21,
      accuracyBar: 0.8,
      levelsToGo: 9,
      levelMet: false,
      accuracyMet: true,
    },
    ...over,
  } as never);

describe('accuracyLine', () => {
  it('names the accuracy and the bar for the rank', () => {
    expect(accuracyLine(standing())).toBe('Accuracy 82% · the bar for a Knight is 70%');
  });
  it('says so when below the bar', () => {
    const rating = { accuracy: 0.5, bar: 0.7, belowBar: true, graded: 80, minGraded: 50 };
    expect(accuracyLine(standing({ rating }))).toBe(
      'Accuracy 50% · the bar for a Knight is 70% · below it: reduced weight and gold'
    );
  });
  it('shows grading progress before the player is rated', () => {
    const rating = { accuracy: null, bar: 0.7, belowBar: false, graded: 12, minGraded: 50 };
    expect(accuracyLine(standing({ rating }))).toBe('Accuracy: not yet rated, 12/50 graded');
  });
  it('is empty for a rank with no bar', () => {
    const rating = { accuracy: null, bar: null, belowBar: false, graded: 0, minGraded: 50 };
    expect(accuracyLine(standing({ rating }))).toBeNull();
  });
});

describe('nextRankLine', () => {
  it('says how far the next rank is', () => {
    expect(nextRankLine(standing())).toBe(
      'Next, Templar: level 21, 9 to go and accuracy of 80% or more (reached)'
    );
  });
  it('is empty at the top', () => {
    expect(nextRankLine(standing({ nextRank: null }))).toBeNull();
  });
});

describe('restartLosses', () => {
  it('lists what a restart takes, with the player numbers, and never mentions smites', () => {
    const losses = restartLosses(standing());
    expect(losses.map((l) => l.title)).toEqual([
      'Your rank',
      'Your level and experience',
      'Gold you have not yet converted',
    ]);
    expect(losses[1].detail).toBe('Level 12 and 640 XP, back to the start.');
    expect(losses[2].detail).toBe('3,200 earned and 500 still pending.');
    expect(JSON.stringify(losses).toLowerCase()).not.toContain('smite');
  });
});

describe('smiteHeading', () => {
  it('counts the smites in words', () => {
    expect(smiteHeading(1)).toBe('One smite weighs on you.');
    expect(smiteHeading(2)).toBe('Two smites weigh on you.');
    expect(smiteHeading(7)).toBe('7 smites weigh on you.');
  });
});
