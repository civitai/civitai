import {
  CAP_DEFINITIONS,
  MIN_CAP,
  type CapDefinition,
} from '~/shared/constants/creator-program.constants';
import type { UserTier } from '~/server/schema/user.schema';

export function getCapForDefinition(def: CapDefinition, peakEarned: number): number {
  let cap = def.limit ?? MIN_CAP;
  if (def.percentOfPeakEarning && peakEarned) {
    const peakEarnedCap = peakEarned * def.percentOfPeakEarning;
    if (peakEarnedCap < MIN_CAP) cap = MIN_CAP;
    else cap = Math.min(peakEarnedCap, def.limit ?? Infinity);
  }
  return cap;
}

export function getNextCapDefinition(
  currentTier: UserTier,
  currentCap: number,
  peakEarned: number
): CapDefinition | undefined {
  return CAP_DEFINITIONS.find((c) => {
    if (c.tier === currentTier || c.hidden) return false;
    return getCapForDefinition(c, peakEarned) > currentCap;
  });
}
