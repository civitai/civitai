// Creator Program compensation-pool value math — the shared source of truth for both the main app
// (src/server/utils/creator-program.utils.ts re-exports these) and the creator-studio spoke
// (apps/creator-studio/src/lib/server/creator-program.ts). Pure and dependency-free / browser-safe:
// buzz → projected USD, capped at $1 per 1000 buzz. Mirrors the `licensing-fee.ts` shared-math pattern.

/** The compensation-pool figures these projections read: the pool's total USD `value`, and the buzz
 *  `size` used as the denominator — `forecasted` = end-of-month projection, `current` = live pool. */
export type CompensationPoolValueInput = {
  value: number;
  size: { forecasted: number; current?: number };
};

/** Projected USD for `toBank` buzz against the **forecasted** pool size — the "your Buzz could be worth
 *  $X" join/earn estimate. Hard-capped at $1 per 1000 buzz; a zero/absent forecast → the cap (÷∞). */
export function getForecastedValue(
  toBank: number,
  pool: { size: { forecasted: number }; value: number }
): number {
  // toBank / 1000 ensures we cap at $1 per 1000 buzz
  return Math.min((toBank / pool.size.forecasted) * pool.value, toBank / 1000);
}

/** Projected USD against the **current** (live) pool size — used for an already-banked amount.
 *  Returns 0 when the live pool is empty; hard-capped at $1 per 1000 buzz. */
export function getCurrentValue(
  toBank: number,
  pool: { size: { forecasted: number; current: number }; value: number }
): number {
  if (pool.size.current === 0) return 0;

  // toBank / 1000 ensures we cap at $1 per 1000 buzz
  return Math.min((toBank / pool.size.current) * pool.value, toBank / 1000);
}
