import { getLevelProgression } from '@civitai/shared/new-order-levels';

/** Total XP at which a level starts, found on the shared curve so it cannot drift from it. */
export function expForLevel(level: number): number {
  let high = 1;
  while (getLevelProgression(high).level < level) high *= 2;
  let low = Math.floor(high / 2);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getLevelProgression(mid).level < level) low = mid + 1;
    else high = mid;
  }
  return low;
}
