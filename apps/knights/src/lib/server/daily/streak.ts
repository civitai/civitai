import { DAILY } from './config';
import { daysBetween, isoWeekStart, type Day } from './days';

export type StreakState = {
  streak: number;
  lastWatchDay: Day | null;
  shields: number;
  /** The Monday of the ISO week a shield was last granted for. */
  shieldWeek: Day;
};

export const newPlayerState = (today: Day): StreakState => ({
  streak: 0,
  lastWatchDay: null,
  shields: DAILY.maxShields,
  shieldWeek: isoWeekStart(today),
});

/** Granted lazily when a new ISO week is first seen, one per week that passed, never above the cap. */
export function grantWeeklyShield(state: StreakState, today: Day): StreakState {
  const week = isoWeekStart(today);
  const weeks = Math.floor(daysBetween(state.shieldWeek, week) / 7);
  if (weeks <= 0) return state;
  return {
    ...state,
    shields: Math.min(DAILY.maxShields, state.shields + weeks),
    shieldWeek: week,
  };
}

export type Advanced = StreakState & { shieldUsed: boolean };

/**
 * Applies a completed Watch on `today`. Shields are spent here, not when the day is missed: a player
 * who never returns keeps theirs, and one granted by the new week can still cover yesterday.
 */
export function advanceStreak(before: StreakState, today: Day): Advanced {
  const state = grantWeeklyShield(before, today);
  if (state.lastWatchDay === null) {
    return { ...state, streak: 1, lastWatchDay: today, shieldUsed: false };
  }
  const missed = daysBetween(state.lastWatchDay, today) - 1;
  if (missed <= 0)
    return { ...state, streak: state.streak + 1, lastWatchDay: today, shieldUsed: false };
  if (missed === 1 && state.shields > 0) {
    return {
      ...state,
      streak: state.streak + 1,
      lastWatchDay: today,
      shields: state.shields - 1,
      shieldUsed: true,
    };
  }
  return { ...state, streak: 1, lastWatchDay: today, shieldUsed: false };
}

/** The streak as the player would see it today, before they finish today's Watch. */
export function liveStreak(before: StreakState, today: Day): number {
  if (before.lastWatchDay === null) return 0;
  const state = grantWeeklyShield(before, today);
  const missed = daysBetween(before.lastWatchDay, today) - 1;
  if (missed <= 0) return state.streak;
  return missed === 1 && state.shields > 0 ? state.streak : 0;
}

/** A career reset ends the streak; shields are kept. */
export const voidStreak = (state: StreakState): StreakState => ({
  ...state,
  streak: 0,
  lastWatchDay: null,
});

/** Whether a shield would keep the streak alive if today's Watch is missed. */
export function shieldCoversToday(state: StreakState, today: Day): boolean {
  if (liveStreak(state, today) === 0 || state.lastWatchDay === null) return false;
  return (
    daysBetween(state.lastWatchDay, today) === 1 && grantWeeklyShield(state, today).shields > 0
  );
}
