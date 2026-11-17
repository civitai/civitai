// Hat Turf's time-varying numbers: sticker supply, its catch-up multiplier, how many stickerers
// an image credits, and how long a sticker counts. All are step schedules so they can ramp through the event without a deploy (see
// config.ts).

export type TurfStep = { from: Date };
export type SupplyStep = TurfStep & { perHour: number; cap: number };
export type CreditStep = TurfStep & { players: number };
// A team's supply scales from `max` (at or past `gap` below the mean of all teams' points, as a
// fraction of the mean) through 1 (at the mean) to `min` (at or past `gap` above it).
export type CatchUpStep = TurfStep & { max: number; min: number; gap: number };

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

/**
 * When the next whole sticker arrives, at the rate in force at `now`; null when the bucket is at its
 * cap or does not grow. A later step changing the rate makes this early or late: callers re-read.
 */
export function nextStickerAt(stock: number, now: Date, step: SupplyStep | undefined): Date | null {
  if (!step || step.perHour <= 0 || stock >= step.cap) return null;
  const wait = Math.floor(stock) + 1 - stock;
  return new Date(now.getTime() + (wait / step.perHour) * HOUR_MS);
}

/** The multiplier on a team's refill rate and cap, from its points and the mean of every team's. */
export function catchUpMultiplier(step: CatchUpStep | undefined, points: number, mean: number) {
  if (!step || !(mean > 0) || !(step.gap > 0)) return 1;
  const gap = (points - mean) / mean;
  const reach = Math.min(1, Math.abs(gap) / step.gap);
  return gap < 0 ? 1 + (step.max - 1) * reach : 1 - (1 - step.min) * reach;
}

/**
 * The supply schedule with every step's rate and cap scaled by `multiplier`. Caps stay whole
 * stickers, rounded down; the epsilon keeps 0.58 x 50 (28.999...) from flooring to 28.
 */
export function scaleSupply(
  steps: readonly SupplyStep[],
  multiplier: number
): readonly SupplyStep[] {
  if (multiplier === 1) return steps;
  return steps.map((step) => ({
    ...step,
    perHour: step.perHour * multiplier,
    cap: Math.floor(step.cap * multiplier + 1e-9),
  }));
}

/**
 * How many of a team's stickerers an action on an image it leads credits: the step's `players`
 * scaled by the team's credit catch-up, never below 1. No step in force credits no one.
 */
export function scaleCredited(base: number, multiplier: number) {
  return base > 0 ? Math.max(1, Math.round(base * multiplier)) : 0;
}

// A sticker counts for `ttlHours` from when it was placed, or from `rolloutAt` if it was placed
// before then, so turning expiry on never expires a sticker at once. No `ttlHours`: none expire.
export type StickerExpiry = { ttlHours?: number; rolloutAt?: Date };

/** When a sticker placed at `createdAt` stops counting; null when stickers do not expire. */
export function stickerExpiresAt(createdAt: Date, { ttlHours, rolloutAt }: StickerExpiry) {
  if (!ttlHours || !(ttlHours > 0)) return null;
  const from = rolloutAt && rolloutAt > createdAt ? rolloutAt : createdAt;
  return new Date(from.getTime() + ttlHours * HOUR_MS);
}

/**
 * The stickers still counting at `now` are those placed after this (stickerExpiresAt > now, as a
 * bound on createdAt the queries can use). Null when none has expired yet: no expiry, or every
 * sticker is still inside its fresh lifetime from `rolloutAt`.
 */
export function stickerLiveAfter({ ttlHours, rolloutAt }: StickerExpiry, now: Date) {
  if (!ttlHours || !(ttlHours > 0)) return null;
  const cutoff = new Date(now.getTime() - ttlHours * HOUR_MS);
  if (rolloutAt && rolloutAt > cutoff) return null;
  return cutoff;
}
