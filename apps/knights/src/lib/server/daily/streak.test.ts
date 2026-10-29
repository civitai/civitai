import { describe, expect, it } from 'vitest';
import { DAILY } from './config';
import {
  advanceStreak,
  grantWeeklyShield,
  liveStreak,
  newPlayerState,
  type StreakState,
} from './streak';

// 2026-12-14 is a Monday.
const state = (over: Partial<StreakState> = {}): StreakState => ({
  streak: 0,
  lastWatchDay: null,
  shields: 0,
  shieldWeek: '2026-12-14',
  ...over,
});

describe('newPlayerState', () => {
  it('starts with the weekly shield for the week of the first vote', () => {
    expect(newPlayerState('2026-12-17')).toEqual({
      streak: 0,
      lastWatchDay: null,
      shields: DAILY.maxShields,
      shieldWeek: '2026-12-14',
    });
  });
});

describe('grantWeeklyShield', () => {
  it('grants one shield when a new ISO week has begun', () => {
    expect(grantWeeklyShield(state({ shields: 0 }), '2026-12-21')).toMatchObject({
      shields: 1,
      shieldWeek: '2026-12-21',
    });
  });

  it('grants nothing inside the same week', () => {
    const same = state({ shields: 0 });
    expect(grantWeeklyShield(same, '2026-12-20')).toEqual(same);
  });

  it('does not stockpile beyond the cap, however many weeks passed', () => {
    expect(grantWeeklyShield(state({ shields: 0 }), '2027-02-01').shields).toBe(DAILY.maxShields);
    expect(grantWeeklyShield(state({ shields: DAILY.maxShields }), '2026-12-28').shields).toBe(
      DAILY.maxShields
    );
  });
});

describe('advanceStreak', () => {
  it('starts a streak at 1 on the first Watch', () => {
    expect(advanceStreak(state(), '2026-12-15')).toMatchObject({
      streak: 1,
      lastWatchDay: '2026-12-15',
      shieldUsed: false,
    });
  });

  it('grows on consecutive days', () => {
    const next = advanceStreak(state({ streak: 4, lastWatchDay: '2026-12-15' }), '2026-12-16');
    expect(next).toMatchObject({ streak: 5, shieldUsed: false });
  });

  it('resets to 1 after a missed day with no shield', () => {
    const next = advanceStreak(state({ streak: 4, lastWatchDay: '2026-12-15' }), '2026-12-17');
    expect(next).toMatchObject({ streak: 1, shields: 0, shieldUsed: false });
  });

  it('spends a shield to cover exactly one missed day', () => {
    const next = advanceStreak(
      state({ streak: 4, lastWatchDay: '2026-12-15', shields: 1 }),
      '2026-12-17'
    );
    expect(next).toMatchObject({ streak: 5, shields: 0, shieldUsed: true });
  });

  it('does not cover two missed days, and keeps the shield', () => {
    const next = advanceStreak(
      state({ streak: 4, lastWatchDay: '2026-12-15', shields: 1 }),
      '2026-12-18'
    );
    expect(next).toMatchObject({ streak: 1, shields: 1, shieldUsed: false });
  });

  it('counts a shield granted by the week the Watch lands in', () => {
    const next = advanceStreak(
      state({ streak: 3, lastWatchDay: '2026-12-19', shields: 0, shieldWeek: '2026-12-14' }),
      '2026-12-21'
    );
    expect(next).toMatchObject({
      streak: 4,
      shields: 0,
      shieldUsed: true,
      shieldWeek: '2026-12-21',
    });
  });
});

describe('liveStreak', () => {
  it('is the stored streak while today or yesterday was the last Watch', () => {
    expect(liveStreak(state({ streak: 3, lastWatchDay: '2026-12-15' }), '2026-12-15')).toBe(3);
    expect(liveStreak(state({ streak: 3, lastWatchDay: '2026-12-15' }), '2026-12-16')).toBe(3);
  });

  it('is 0 once a day was missed and no shield will cover it', () => {
    expect(liveStreak(state({ streak: 3, lastWatchDay: '2026-12-15' }), '2026-12-17')).toBe(0);
  });

  it('survives one missed day while a shield is available', () => {
    expect(
      liveStreak(state({ streak: 3, lastWatchDay: '2026-12-15', shields: 1 }), '2026-12-17')
    ).toBe(3);
    expect(
      liveStreak(state({ streak: 3, lastWatchDay: '2026-12-15', shields: 1 }), '2026-12-18')
    ).toBe(0);
  });
});
