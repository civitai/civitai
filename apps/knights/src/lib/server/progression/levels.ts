import { getLevelProgression } from '@civitai/shared/new-order-levels';

const MAX_EXP = 2 ** 31 - 1;

/** The highest level whose starting XP fits the Int `exp` column. */
export const MAX_LEVEL = getLevelProgression(MAX_EXP).level;

/** Total XP at which a level starts, found on the shared curve so it cannot drift from it. */
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
