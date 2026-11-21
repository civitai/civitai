// Creator Program compensation-pool value math — the shared source of truth for both the main app
// (src/server/utils/creator-program.utils.ts re-exports these) and the creator-studio spoke
// (apps/creator-studio/src/lib/server/creator-program.ts). Pure and dependency-free / browser-safe:
// buzz → projected USD, capped at $1 per 1000 buzz. Mirrors the `licensing-fee.ts` shared-math pattern.

/** Creator score needed to join the Creator Program. Here so the main app and the studio read one number. */
export const CREATOR_PROGRAM_MIN_CREATOR_SCORE = 40000;

/** Settled cash a creator needs before they can withdraw, in USD cents. */
export const CREATOR_PROGRAM_MIN_WITHDRAWAL_AMOUNT = 5000;

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

/** ClickHouse SQL for the Buzz net-banked into one month's pool (banks minus extractions), the
 *  figure the month's payout divides the pool by. `monthAccount` is the YYYYMM bank account id;
 *  `bankableTypesSql` the quoted bankable account types, e.g. `'yellow', 'green'`. */
export function poolNetBankedSql(monthAccount: number, bankableTypesSql: string): string {
  const month = Math.trunc(monthAccount);
  return `
    SELECT SUM(if(toAccountType = 'creatorProgramBank', amount, -amount)) AS balance
    FROM buzzTransactions
    WHERE (
      toAccountType = 'creatorProgramBank'
      AND toAccountId = ${month}
      AND fromAccountType IN (${bankableTypesSql})
    ) OR (
      fromAccountType = 'creatorProgramBank'
      AND fromAccountId = ${month}
      AND toAccountType IN (${bankableTypesSql})
    )`;
}

/** The pool size a forecast divides by: what last month's pool ended at, or what is banked
 *  already if this month has passed it. */
export function forecastPoolSize(lastMonthNetBanked: number, currentBanked: number): number {
  return Math.max(lastMonthNetBanked, currentBanked);
}
