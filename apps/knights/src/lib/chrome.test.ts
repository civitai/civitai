import { describe, expect, it } from 'vitest';
import {
  accuracyLine,
  belowBarCue,
  withVotesSent,
  withArticle,
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

  it('treats a done Watch as a goal reached, not the end of the day', () => {
    expect(watchStrip({ ...daily, votes: 10, watchDone: true }).note).toBe(
      '+500 gold bonus earned · keep judging'
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
    level: 41,
    exp: 640,
    goldUnspent: 3200,
    goldPending: 500,
    rating: { accuracy: 0.82, bar: 0.7, belowBar: false, graded: 80, minGraded: 50 },
    nextRank: {
      rank: 'Templar',
      fromLevel: 50,
      accuracyBar: 0.8,
      levelsToGo: 9,
      levelMet: false,
      accuracyMet: true,
      minDaysPlayed: 0,
      daysPlayed: 0,
      daysToGo: 0,
      daysMet: true,
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
      'Accuracy 50% · the bar for a Knight is 70% · below it: reduced gold'
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
      'Next, Templar: level 50, 9 to go and accuracy of 80% or more (reached)'
    );
  });
  it('adds the days played when the rank asks for them', () => {
    const paladin = {
      rank: 'Paladin',
      fromLevel: 90,
      accuracyBar: 0.85,
      levelsToGo: 0,
      levelMet: true,
      accuracyMet: true,
      minDaysPlayed: 60,
      daysPlayed: 45,
      daysToGo: 15,
      daysMet: false,
    };
    expect(nextRankLine(standing({ nextRank: paladin }))).toBe(
      'Next, Paladin: level 90 (reached), accuracy of 85% or more (reached) and 60 days played (have 45)'
    );
    expect(
      nextRankLine(
        standing({ nextRank: { ...paladin, daysPlayed: 60, daysToGo: 0, daysMet: true } })
      )
    ).toBe(
      'Next, Paladin: level 90 (reached), accuracy of 85% or more (reached) and 60 days played (reached)'
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
      'Gold you have not yet spent',
    ]);
    expect(losses[1].detail).toBe('Level 41 and 640 XP, back to the start.');
    expect(losses[2].detail).toBe('3,200 unspent and 500 still pending.');
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

describe('belowBarCue', () => {
  const rating = (o: object) => ({
    accuracy: 0.77,
    bar: 0.8,
    belowBar: true,
    graded: 500,
    minGraded: 20,
    ...o,
  });

  it('says how far under their own rank bar a player is, and what it costs', () => {
    expect(belowBarCue({ rank: 'Templar', rating: rating({}) })).toBe(
      'Below the Templar bar (77% / 80%): gold counts half'
    );
  });

  it('is silent on the bar, unrated, or with no bar for the rank', () => {
    expect(
      belowBarCue({ rank: 'Templar', rating: rating({ belowBar: false, accuracy: 0.9 }) })
    ).toBeNull();
    expect(
      belowBarCue({ rank: 'Templar', rating: rating({ accuracy: null, belowBar: false }) })
    ).toBeNull();
    expect(
      belowBarCue({ rank: 'Acolyte', rating: rating({ bar: null, belowBar: false }) })
    ).toBeNull();
  });
});

describe('withArticle', () => {
  it('uses an before a vowel', () => {
    expect(withArticle('Acolyte')).toBe('an Acolyte');
    expect(withArticle('Inquisitor')).toBe('an Inquisitor');
    expect(withArticle('Knight')).toBe('a Knight');
    expect(withArticle('Templar')).toBe('a Templar');
  });
});

describe('withVotesSent', () => {
  it('counts votes still on their way, and completes the Watch when they reach it', () => {
    expect(withVotesSent(daily, 2)).toMatchObject({ votes: 7, watchDone: false });
    expect(withVotesSent(daily, 5)).toMatchObject({ votes: 10, watchDone: true });
    expect(watchStrip(withVotesSent(daily, 2)).value).toBe(7);
  });

  it('leaves the status alone with nothing in flight', () => {
    expect(withVotesSent(daily, 0)).toBe(daily);
  });

  it('advances the streak with the vote that completes the Watch', () => {
    expect(withVotesSent({ ...daily, streak: 0 }, 5)).toMatchObject({ streak: 1, watchDone: true });
    expect(withVotesSent({ ...daily, votes: 9, streak: 4 }, 1)).toMatchObject({ streak: 5 });
  });

  it('leaves the streak alone before the Watch is done and once it already is', () => {
    expect(withVotesSent({ ...daily, streak: 4 }, 4)).toMatchObject({
      streak: 4,
      watchDone: false,
    });
    expect(withVotesSent({ ...daily, votes: 10, watchDone: true, streak: 5 }, 1)).toMatchObject({
      streak: 5,
    });
  });
});
