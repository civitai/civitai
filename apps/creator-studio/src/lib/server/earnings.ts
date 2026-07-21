import { getClickhouse } from '$lib/server/clickhouse';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';
import type { EarningsSource } from '$lib/earnings';

// Earnings by source — A1 **Part 1**. Creators are paid through `default.buzzTransactions`, which is already keyed
// by the creator (`toAccountId` = creator userId, verified 1:1), so these totals need NO owner-keyed rollup /
// dictionary / CDC. That dependency only remains for the per-MODEL breakdown (A1 Part 2). Full rationale, filters,
// and gotchas: docs/creator-studio/owner-rollup-handoff.md.

// Sources derive from `buzzTransactions.type` (+ the `early-access-` prefix for access sales). `licenseFee` also
// matches mislabelled `'27'` rows — an upstream ingest bug (see handoff doc §🔴). The source vocabulary lives in
// the client-safe $lib/earnings so the pages share it.
// Currencies are kept as raw `toAccountType` and NEVER converted or merged (B8 / D1): yellow, blue, green,
// cashSettled, cashPending, creatorProgramBank, creatorProgramBankGreen, club, …
export type EarningsBucket = {
  source: EarningsSource;
  currency: string;
  total: number;
  count: number;
};
// The trend series is per-source, buzz-only (the chart is a buzz trend; cash lives in the panel). One line per
// source with toggle chips (E4). Currency detail stays in the by-source×currency summary/table.
export type EarningsPoint = { date: string; source: EarningsSource; total: number };

// Only the creator's *receiving* rows count as earnings: tip / compensation / licenseFee (+ the `'27'` mislabel) /
// cosmetic `sell`, plus `purchase` rows that are early-access sales (a bare `purchase` is mostly the creator
// topping up their own buzz — see handoff doc §gotchas).
const RECEIVING_TYPES = `(type IN ('tip','compensation','licenseFee','27','sell') OR (type = 'purchase' AND externalTransactionId LIKE 'early-access-%'))`;
// `from`/`to` are validated ISO dates (parseRange), so they're interpolated directly; the upper bound is
// exclusive-next-day so it's inclusive of the whole `to` day.
const whereClause = (uid: number, from: string, to: string) =>
  `toAccountId = ${uid} AND date >= toDate('${from}') AND date < toDate('${to}') + 1 AND ${RECEIVING_TYPES}`;

const SOURCE_EXPR = `multiIf(type = 'tip', 'tip', type = 'compensation', 'compensation', type IN ('licenseFee','27'), 'licenseFee', type = 'sell', 'cosmeticSale', 'accessSale')`;

async function fetchSummary({
  userId,
  from,
  to,
}: {
  userId: number;
  from: string;
  to: string;
}): Promise<EarningsBucket[]> {
  const uid = Number(userId);
  const rows = await getClickhouse().$query<{
    source: EarningsSource;
    currency: string;
    total: number | string;
    count: number | string;
  }>(
    `SELECT ${SOURCE_EXPR} AS source, toAccountType AS currency, sum(amount) AS total, count() AS count
     FROM default.buzzTransactions
     WHERE ${whereClause(uid, from, to)}
     GROUP BY source, currency
     ORDER BY total DESC`
  );
  return rows.map((r) => ({
    source: r.source,
    currency: r.currency,
    total: Number(r.total),
    count: Number(r.count),
  }));
}

async function fetchSeries({
  userId,
  from,
  to,
}: {
  userId: number;
  from: string;
  to: string;
}): Promise<EarningsPoint[]> {
  const uid = Number(userId);
  const rows = await getClickhouse().$query<{
    date: string;
    source: EarningsSource;
    total: number | string;
  }>(
    `SELECT toDate(date) AS date, ${SOURCE_EXPR} AS source, sum(amount) AS total
     FROM default.buzzTransactions
     WHERE ${whereClause(uid, from, to)} AND toAccountType IN ('yellow','blue','green','club')
     GROUP BY date, source
     ORDER BY date`
  );
  return rows.map((r) => ({ date: String(r.date), source: r.source, total: Number(r.total) }));
}

// By-source × currency totals over the range — the /earnings source cards and the dashboard headline.
export const getEarningsSummary = createCache({
  name: 'earnings:summary',
  fetch: fetchSummary,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Per-source buzz totals over time — the /earnings trend chart.
export const getEarningsSeries = createCache({
  name: 'earnings:series',
  fetch: fetchSeries,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Monthly buzz earnings for the last 12 months — the /earnings "monthly performance" table (feedback 3.4). Buzz
// only (cash lives in its own panel); currencies kept split (B8). Independent of the page's selected range, so a
// creator can always see this-month-vs-prior-months. `month` is the first-of-month ISO date.
export type MonthlyEarning = { month: string; currency: string; total: number };

async function fetchMonthly({ userId }: { userId: number }): Promise<MonthlyEarning[]> {
  const uid = Number(userId);
  const rows = await getClickhouse().$query<{
    month: string;
    currency: string;
    total: number | string;
  }>(
    `SELECT toString(toStartOfMonth(date)) AS month, toAccountType AS currency, sum(amount) AS total
     FROM default.buzzTransactions
     WHERE toAccountId = ${uid}
       AND date >= toStartOfMonth(today() - INTERVAL 11 MONTH)
       AND toAccountType IN ('yellow','blue','green','club')
       AND ${RECEIVING_TYPES}
     GROUP BY month, currency
     ORDER BY month DESC`
  );
  return rows.map((r) => ({ month: String(r.month), currency: r.currency, total: Number(r.total) }));
}

export const getMonthlyEarnings = createCache({
  name: 'earnings:monthly',
  fetch: fetchMonthly,
  ttlSeconds: 3600,
}).get;

// Buzz→$ conversion history (feedback 868ke492x) — what a creator's banked Buzz was actually worth in dollars each
// month. Two ClickHouse inputs per month:
//   • net banked Buzz = `bank` (creator's yellow/green → creatorProgramBank[Green]) minus un-bank `withdrawal`/`refund`
//     (creatorProgramBank[Green] → back to the creator). This is what they committed to that month's pool.
//   • comp cash = the `compensation` grant into `cashPending` (externalId `comp-pool-unified-YYYY-MM-<userId>`), whose
//     `amount` is in CENTS. This is NOT a CashWithdrawal — it's the pool payout for that month.
// rate = compUsd / netBankedBuzz, capped at $0.001/Buzz (the pool's hard $1-per-1k ceiling). The current month is
// naturally excluded: banking has happened but the pool hasn't settled, so there's no comp grant yet (HAVING drops it).
// Program launched Mar 2025, so nothing earlier exists to query.
export type BuzzDollarRatio = { month: string; bankedBuzz: number; usd: number; perThousand: number };

async function fetchBuzzRatio({ userId }: { userId: number }): Promise<BuzzDollarRatio[]> {
  const uid = Number(userId);
  const rows = await getClickhouse().$query<{
    month: string;
    comp_cents: number | string;
    net_banked: number | string;
  }>(
    `SELECT toString(m) AS month,
            sumIf(amount, kind = 'comp') AS comp_cents,
            sumIf(amount, kind = 'bank') - sumIf(amount, kind = 'extract') AS net_banked
     FROM (
       SELECT toStartOfMonth(date) AS m, amount,
         multiIf(
           type = 'compensation' AND toAccountType = 'cashPending' AND externalTransactionId LIKE 'comp-pool-unified-%', 'comp',
           type = 'bank' AND fromAccountId = ${uid} AND toAccountType IN ('creatorProgramBank','creatorProgramBankGreen'), 'bank',
           type IN ('withdrawal','refund') AND toAccountId = ${uid} AND fromAccountType IN ('creatorProgramBank','creatorProgramBankGreen'), 'extract',
           'x') AS kind
       FROM default.buzzTransactions
       WHERE (toAccountId = ${uid} OR fromAccountId = ${uid}) AND date >= toDate('2025-03-01')
     ) WHERE kind != 'x'
     GROUP BY m
     HAVING sumIf(amount, kind = 'comp') > 0 AND (sumIf(amount, kind = 'bank') - sumIf(amount, kind = 'extract')) > 0
     ORDER BY m DESC`
  );
  return rows.map((r) => {
    const usd = Number(r.comp_cents) / 100;
    const bankedBuzz = Number(r.net_banked);
    const perThousand = Math.min(usd / bankedBuzz, 0.001) * 1000;
    return { month: String(r.month), bankedBuzz, usd, perThousand };
  });
}

export const getBuzzDollarRatio = createCache({
  name: 'earnings:buzz-ratio',
  fetch: fetchBuzzRatio,
  ttlSeconds: 3600,
}).get;
