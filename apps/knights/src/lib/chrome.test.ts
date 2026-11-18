import { describe, expect, it } from 'vitest';
import {
  accuracyLine,
  goldToday,
  pendingGoldVotes,
  neverBelowToday,
  belowBarCue,
  headerDaily,
  landVote,
  pendingVotes,
  withVotesSent,
  withArticle,
  heartsLeft,
  heartBackLine,
  heartBackShort,
  noticeTone,
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

describe('heartBackLine', () => {
  it('says how many more right verdicts win back the next heart', () => {
    expect(heartBackLine({ done: 12, needed: 25 })).toBe(
      '12 of 25 right verdicts to win back a heart'
    );
  });

  it('says nothing with no heart to win back', () => {
    expect(heartBackLine(null)).toBeNull();
  });
});

describe('heartBackShort', () => {
  it('is the compact count for the rail and the mobile meta row', () => {
    expect(heartBackShort({ done: 1, needed: 25 })).toBe('1/25');
    expect(heartBackShort(null)).toBeNull();
  });
});

describe('noticeTone', () => {
  it('is calm only when every notice is a close call', () => {
    expect(noticeTone([{ consequence: 'close' }, { consequence: 'close' }])).toBe('calm');
    expect(noticeTone([{ consequence: 'close' }, { consequence: 'warning' }])).toBe('alarm');
    expect(noticeTone([{ consequence: 'smite' }])).toBe('alarm');
    expect(noticeTone([])).toBe('alarm');
  });
});

describe('watchStrip', () => {
  it('shows progress and the bonus still to earn', () => {
    expect(watchStrip(daily)).toEqual({
      label: "Today's Watch · 5 of 10",
      value: 5,
      max: 10,
      done: false,
      note: '+500 gold at the end',
    });
  });

  it('never counts past the Watch size', () => {
    expect(watchStrip({ ...daily, votes: 14 })).toMatchObject({
      label: "Today's Watch · 10 of 10",
      value: 10,
    });
  });

  it('says a done Watch is complete and its bonus earned', () => {
    expect(watchStrip({ ...daily, votes: 10, watchDone: true }).note).toBe(
      'Watch complete, +500 gold streak bonus'
    );
  });

  it('says the gold cap is reached, and that XP still counts', () => {
    expect(watchStrip({ ...daily, capReached: true }).note).toBe(
      'Gold cap reached · XP still counts'
    );
  });

  it('says a done Watch at the gold cap is complete, with the cap note as secondary text', () => {
    expect(watchStrip({ ...daily, votes: 10, watchDone: true, capReached: true })).toMatchObject({
      done: true,
      note: 'Watch complete, +500 gold streak bonus',
      sub: 'Gold cap reached · XP still counts',
    });
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

describe('pendingVotes / landVote', () => {
  it('never counts a vote twice while the refreshed daily that holds it replaces the old one', () => {
    const before = { ...daily, votes: 9 };
    const sent = { count: 1, landed: 0, landedOn: null as number | null };
    expect(withVotesSent(before, pendingVotes(sent, before)).votes).toBe(10);
    landVote(sent, before);
    expect(withVotesSent(before, pendingVotes(sent, before)).votes).toBe(10);
    const after = { ...daily, votes: 10, watchDone: true };
    expect(withVotesSent(after, pendingVotes(sent, after)).votes).toBe(10);
  });

  it('keeps several landed votes counted until the daily changes', () => {
    const before = { ...daily, votes: 3 };
    const sent = { count: 2, landed: 0, landedOn: null as number | null };
    landVote(sent, before);
    landVote(sent, before);
    expect(sent.count).toBe(0);
    expect(pendingVotes(sent, before)).toBe(2);
    expect(pendingVotes(sent, { ...daily, votes: 5 })).toBe(0);
  });
});

describe('withVotesSent', () => {
  it('adds the gold each vote still on its way records, up to the daily cap', () => {
    const paid = { ...daily, goldRecorded: 79_800, goldCap: 80_000, goldPerVote: 100 };
    expect(withVotesSent(paid, 1)).toMatchObject({ goldRecorded: 79_900, capReached: false });
    expect(withVotesSent(paid, 3)).toMatchObject({ goldRecorded: 80_000, capReached: true });
    // A rank that earns no gold, or a daily without the per-vote amount, keeps the gold it had.
    expect(withVotesSent({ ...paid, goldCap: 0 }, 2)).toMatchObject({ goldRecorded: 79_800 });
    expect(withVotesSent(daily, 2)).not.toHaveProperty('goldRecorded');
  });

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

  it('shows the Watch as completed with the vote that completes it', () => {
    const lastVote = { ...daily, votes: 9, streak: 4 };
    expect(watchStrip(withVotesSent(lastVote, 0))).toMatchObject({
      done: false,
      note: '+500 gold at the end',
    });
    const completed = withVotesSent(lastVote, 1);
    expect(watchStrip(completed)).toMatchObject({
      value: 10,
      done: true,
      note: 'Watch complete, +500 gold streak bonus',
    });
    expect(completed.streak).toBe(5);
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

describe('headerDaily', () => {
  it('the header streak moves with the vote that completes the Watch', () => {
    const playDaily = { ...daily, votes: 9, streak: 4, shields: 1, maxShields: 2 };
    const layoutDaily = { streak: 4, shields: 1, maxShields: 2 };
    expect(headerDaily(playDaily, layoutDaily, 1)).toMatchObject({
      streak: 5,
      shields: 1,
      maxShields: 2,
    });
    expect(headerDaily(playDaily, layoutDaily, 1).streak).toBe(withVotesSent(playDaily, 1).streak);
  });

  it("the header keeps the layout's copy untouched with no vote in flight or no page daily", () => {
    const pageDaily = { ...daily, streak: 4, shields: 1, maxShields: 2 };
    const layoutDaily = { streak: 3, shields: 0, maxShields: 2 };
    expect(headerDaily(pageDaily, layoutDaily, 0)).toBe(pageDaily);
    expect(headerDaily(null, layoutDaily, 2)).toBe(layoutDaily);
    expect(headerDaily(undefined, undefined, 0)).toBeUndefined();
  });
});

describe('goldToday', () => {
  it("reads today's gold against the cap, full once it is reached", () => {
    expect(goldToday({ goldRecorded: 12_400, goldCap: 80_000 })).toEqual({
      label: '12,400 of 80,000',
      ratio: 0.155,
      reached: false,
    });
    expect(goldToday({ goldRecorded: 80_000, goldCap: 80_000 })).toMatchObject({
      ratio: 1,
      reached: true,
    });
  });

  it('is absent for a rank that earns no gold', () => {
    expect(goldToday({ goldRecorded: 0, goldCap: 0 })).toBeNull();
  });
});

describe('a landed vote in a reactive store', () => {
  it('stays counted when the store wraps the daily it is given, as a Svelte $state proxies a plain object', () => {
    const wrapping = <T extends object>(target: T): T =>
      new Proxy(target, {
        set(t, key, value) {
          Reflect.set(t, key, value && typeof value === 'object' ? new Proxy(value, {}) : value);
          return true;
        },
      });
    const sent = wrapping({ count: 1, landed: 0, landedOn: null as number | null });
    const shown = { votes: 4 };

    landVote(sent, shown);

    // The vote stays on the Watch until the refreshed daily, which holds it, replaces the one on screen.
    expect(pendingVotes(sent, shown)).toBe(1);
    expect(pendingVotes(sent, { votes: 5 })).toBe(0);
  });
});

describe('neverBelowToday', () => {
  it('keeps the highest count seen today, so a refresh served an older count does not move it back', () => {
    let seen = neverBelowToday(null, 120, '2026-11-18');
    expect(seen.value).toBe(120);
    seen = neverBelowToday(seen, 95, '2026-11-18');
    expect(seen.value).toBe(120);
    seen = neverBelowToday(seen, 130, '2026-11-18');
    expect(seen.value).toBe(130);
  });

  it('starts again on a new UTC day', () => {
    const seen = neverBelowToday({ day: '2026-11-18', value: 900 }, 4, '2026-11-19');
    expect(seen).toEqual({ day: '2026-11-19', value: 4 });
  });
});

describe('a vote that counts toward the Watch but pays no gold', () => {
  it('stays on the Watch once landed, and leaves the gold count', () => {
    const sent = { count: 2, landed: 0, landedOn: null as number | null, goldless: 0 };
    const shown = { votes: 4 };
    landVote(sent, shown, { paysGold: false });
    landVote(sent, shown);

    expect(pendingVotes(sent, shown)).toBe(2);
    expect(pendingGoldVotes(sent, shown)).toBe(1);
    // A refreshed daily holds both; neither is added again.
    expect(pendingGoldVotes(sent, { votes: 6 })).toBe(0);
  });
});
