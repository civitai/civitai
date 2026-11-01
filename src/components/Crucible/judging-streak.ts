export type StreakTier = 'none' | 'warm' | 'hot' | 'fire';

export const STREAK_MILESTONE_EVERY = 10;
const HOT_AT = 5;
const FIRE_AT = 10;
const BLAZING_AT = 25;

export function getStreakTier(streak: number): StreakTier {
  if (streak >= FIRE_AT) return 'fire';
  if (streak >= HOT_AT) return 'hot';
  if (streak >= 1) return 'warm';
  return 'none';
}

/** Past 25 the fire tier keeps its gradient but glows harder. */
export function isStreakBlazing(streak: number) {
  return streak >= BLAZING_AT;
}

export function isStreakMilestone(streak: number) {
  return streak > 0 && streak % STREAK_MILESTONE_EVERY === 0;
}
