const BASE_XP_FOR_NEXT_LEVEL = 250;
/** Each level costs this much more than the one before it, up to level `SLOWDOWN_LEVEL`. */
const EARLY_GROWTH_RATE = 1.18;
/** From `SLOWDOWN_LEVEL` on, so that a high rank is a long climb rather than an unreachable one. */
const LATE_GROWTH_RATE = 1.06;
const SLOWDOWN_LEVEL = 20;

const MAX_EXP = 2 ** 31 - 1;

/**
 * The Knights level curve. It matches `@civitai/shared/new-order-levels` (which the original game still uses) up to
 * level 20, then grows slower, so the same XP is a higher level here.
 */
export function getLevelProgression(totalXp: number) {
  let level = 1;
  let xpForCurrentLevel = 0;
  let xpForNextLevel = BASE_XP_FOR_NEXT_LEVEL;
  let remaining = totalXp;

  while (remaining >= xpForNextLevel) {
    remaining -= xpForNextLevel;
    level++;
    xpForCurrentLevel = xpForNextLevel;
    const growth = level < SLOWDOWN_LEVEL ? EARLY_GROWTH_RATE : LATE_GROWTH_RATE;
    xpForNextLevel = Math.floor(xpForNextLevel * growth);
  }

  const xpIntoLevel = remaining;
  const progressPercent = Math.min((xpIntoLevel / xpForNextLevel) * 100, 100);

  return {
    level,
    totalXp: xpIntoLevel,
    xpForCurrentLevel,
    xpForNextLevel,
    xpIntoLevel,
    xpToNextLevel: xpForNextLevel - xpIntoLevel,
    progressPercent: Math.round(progressPercent * 100) / 100,
  };
}

/** The highest level whose starting XP fits the Int `exp` column. */
export const MAX_LEVEL = getLevelProgression(MAX_EXP).level;

/** Total XP at which a level starts, found on the curve so it cannot drift from it. */
export function expForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`Level must be a whole number from 1 to ${MAX_LEVEL}`);
  }
  let low = 0;
  let high = MAX_EXP;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getLevelProgression(mid).level < level) low = mid + 1;
    else high = mid;
  }
  return low;
}
