import { getClickhouse } from '$lib/server/clickhouse';
import { getBuzz } from '$lib/server/buzz';
import { createCache } from '$lib/server/cache';
import { getForecastedValue } from '@civitai/buzz';
import { env } from '$env/dynamic/private';

// Faithful port of the main app's creator-program compensation-pool math so the Studio's "your buzz could be worth
// $X" pitch (868ke4941) matches the buzz dashboard exactly:
//   - value/forecast queries: src/server/services/creator-program.service.ts getPoolValue / getPoolForecast
//   - the estimate:           src/server/utils/creator-program.utils.ts getForecastedValue (current-month, capped $1/1k buzz)
// The pool figures are platform-wide (not per-user); cached in Redis for a day, matching the main app's cache
// lifetime. Pool config comes from the CREATOR_POOL_* env (main-app runtime secrets) — set them in the Studio env to
// match; otherwise `value` uses the documented 35000 fallback and the forecast portion defaults to 50%, exactly as
// the main app degrades. NOTE (per Briant): as more creator-program surfaces move into the Studio, this pool math is
// a candidate to extract into a shared `@civitai/creator-program` package rather than living per-app.

// BANKABLE_BUZZ_TYPES_STRING in the main app.
const BANKABLE = "'yellow','green'";
const POOL_VALUE_FALLBACK = 35000;

// `valueReal` = poolValue was computed from the real CREATOR_POOL_TAXES/PORTION secrets (vs the flat 35000
// fallback). We only surface a dollar estimate when it's real — a wrong money figure is worse than none.
export type CompensationPool = { value: number; forecasted: number; valueReal: boolean };

async function fetchPool(): Promise<CompensationPool> {
  const taxes = env.CREATOR_POOL_TAXES ? Number(env.CREATOR_POOL_TAXES) : null;
  const portion = env.CREATOR_POOL_PORTION ? Number(env.CREATOR_POOL_PORTION) : null;
  const forecastPortion = Number(env.CREATOR_POOL_FORECAST_PORTION ?? 50);
  const ch = getClickhouse();

  const [valueRows, forecastRows] = await Promise.all([
    // Prior-month gross buzz sales into bankable accounts (÷1000 → the raw pool input).
    ch.$query<{ balance: number | string }>(
      `SELECT SUM(amount) / 1000 AS balance
       FROM buzzTransactions
       WHERE toAccountType IN (${BANKABLE})
         AND (type = 'purchase'
              OR (type = 'redeemable' AND description LIKE 'Redeemed code SH-%')
              OR (type = 'redeemable' AND description LIKE 'Redeemed code KG-%'))
         AND fromAccountId = 0
         AND externalTransactionId NOT LIKE 'renewalBonus:%'
         AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(now(), 1))`
    ),
    // Prior-month compensation/tip + early-access buzz into bankable accounts (the forecast base).
    ch.$query<{ balance: number | string }>(
      `SELECT SUM(amount) AS balance
       FROM buzzTransactions
       WHERE toAccountType IN (${BANKABLE})
         AND ((type IN ('compensation','tip')) OR (type = 'purchase' AND fromAccountId != 0))
         AND toAccountId != 0
         AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(now(), 1))`
    ),
  ]);

  const gross = Number(valueRows[0]?.balance ?? 0);
  // Mirror the main app's fallback (flat 35000) when the tax/portion secrets are missing, but flag it so callers
  // can choose not to show a figure that's only a placeholder.
  const valueReal = valueRows.length > 0 && taxes != null && portion != null;
  const value = valueReal
    ? (gross - gross * (taxes! / 100)) * (portion! / 100)
    : POOL_VALUE_FALLBACK;
  const forecasted = Number(forecastRows[0]?.balance ?? 0) * (forecastPortion / 100);
  return { value, forecasted, valueReal };
}

// Platform pool figures — global (arg-less key), Redis-cached for a day like the main app.
export const getCompensationPool = createCache({
  name: 'creator-program:pool',
  fetch: (_args: Record<string, never>) => fetchPool(),
  ttlSeconds: 86_400,
}).get;

// Both yellow AND green are bankable (BANKABLE_BUZZ_TYPES) and the pool is summed over both, but we keep the two
// SPLIT in the pitch (B8: never merge currencies) — one forecasted payout per type the creator actually holds.
export type BankableBuzzType = 'yellow' | 'green';
export type GetPaidEstimateRow = { type: BankableBuzzType; buzz: number; usd: number };
export type GetPaidEstimate = { rows: GetPaidEstimateRow[]; totalUsd: number };

// Per-type forecasted payout for a (non-member) creator. Returns null when we can't show an honest figure — the
// pool value is only the fallback (CREATOR_POOL_TAXES/PORTION not configured), there's no forecast base, or the
// creator has no bankable buzz. Better to show nothing than a wrong dollar amount.
export async function getGetPaidEstimate(userId: number): Promise<GetPaidEstimate | null> {
  const pool = await getCompensationPool({});
  if (!pool.valueReal || pool.forecasted <= 0) return null;

  const client = getBuzz();
  const [yellow, green] = await Promise.all([
    client.getUserBuzzByAccountType(userId, 'yellow'),
    client.getUserBuzzByAccountType(userId, 'green'),
  ]);

  const input = { value: pool.value, size: { forecasted: pool.forecasted } };
  const rows: GetPaidEstimateRow[] = (
    [
      { type: 'yellow', buzz: yellow?.balance ?? 0 },
      { type: 'green', buzz: green?.balance ?? 0 },
    ] satisfies { type: BankableBuzzType; buzz: number }[]
  )
    .filter((r) => r.buzz > 0)
    .map((r) => ({ ...r, usd: getForecastedValue(r.buzz, input) }));

  if (rows.length === 0) return null;
  return { rows, totalUsd: rows.reduce((sum, r) => sum + r.usd, 0) };
}
