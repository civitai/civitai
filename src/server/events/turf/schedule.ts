// Hat Turf's time-varying numbers: sticker supply and how many stickerers an image credits. Both are
// step schedules so they can ramp through the event without a deploy (see config.ts).

export type TurfStep = { from: Date };
export type SupplyStep = TurfStep & { perHour: number; cap: number };
export type CreditStep = TurfStep & { players: number };

const HOUR_MS = 60 * 60 * 1000;

const byFrom = <T extends TurfStep>(steps: readonly T[]) =>
  [...steps].sort((a, b) => a.from.getTime() - b.from.getTime());

/** The step in force at `at`: the latest one that has started. Undefined before the first. */
export function stepAt<T extends TurfStep>(steps: readonly T[], at: Date): T | undefined {
  let current: T | undefined;
  for (const step of byFrom(steps)) {
    if (step.from > at) break;
    current = step;
  }
  return current;
}

/**
 * A lazy token bucket over a step schedule: the stock at `now`, given `stock` at `since`. Each step's
 * rate applies only for the time it was in force, and the bucket stops growing at the cap in force
 * at that time. A stock already above the cap (left from a higher cap) is kept, never cut.
 * Fractional: callers floor it to count usable stickers.
 */
export function refillStock(
  stock: number,
  since: Date,
  now: Date,
  steps: readonly SupplyStep[]
): number {
  const sorted = byFrom(steps);
  let value = stock;
  for (let i = 0; i < sorted.length; i++) {
    const start = Math.max(sorted[i].from.getTime(), since.getTime());
    const end = Math.min(sorted[i + 1]?.from.getTime() ?? Infinity, now.getTime());
    if (end <= start) continue;
    const { perHour, cap } = sorted[i];
    const grown = Math.min(cap, value + (perHour * (end - start)) / HOUR_MS);
    value = Math.max(value, grown);
  }
  return value;
}
