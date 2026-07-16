import { getClickhouse } from '$lib/server/clickhouse';
import { createCache } from '$lib/server/cache';
import type { EarningsSource } from '$lib/earnings';

// Earnings by source — A1 **Part 1**. Creators are paid through `default.buzzTransactions`, which is already keyed
// by the creator (`toAccountId` = creator userId, verified 1:1), so these totals need NO owner-keyed rollup /
// dictionary / CDC. That dependency only remains for the per-MODEL breakdown (A1 Part 2). Full rationale, filters,
// and gotchas: docs/creator-studio/owner-rollup-handoff.md.

export const EARNINGS_RANGES = [7, 30, 90] as const;
export type EarningsRange = (typeof EARNINGS_RANGES)[number];
export type Granularity = 'day' | 'week';

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

const rangeTtlSeconds = (days: number) => (days >= 90 ? 3600 : days >= 30 ? 900 : 300);

// Only the creator's *receiving* rows count as earnings: tip / compensation / licenseFee (+ the `'27'` mislabel) /
// cosmetic `sell`, plus `purchase` rows that are early-access sales (a bare `purchase` is mostly the creator
// topping up their own buzz — see handoff doc §gotchas). toAccountId is the trusted session id.
const whereClause = (uid: number, days: number) =>
  `toAccountId = ${uid} AND date >= today() - ${days} AND (type IN ('tip','compensation','licenseFee','27','sell') OR (type = 'purchase' AND externalTransactionId LIKE 'early-access-%'))`;

const SOURCE_EXPR = `multiIf(type = 'tip', 'tip', type = 'compensation', 'compensation', type IN ('licenseFee','27'), 'licenseFee', type = 'sell', 'cosmeticSale', 'accessSale')`;

async function fetchSummary({
  userId,
  days,
}: {
  userId: number;
  days: number;
}): Promise<EarningsBucket[]> {
  const uid = Number(userId);
  const d = Number(days);
  const rows = await getClickhouse().$query<{
    source: EarningsSource;
    currency: string;
    total: number | string;
    count: number | string;
  }>(
    `SELECT ${SOURCE_EXPR} AS source, toAccountType AS currency, sum(amount) AS total, count() AS count
     FROM default.buzzTransactions
     WHERE ${whereClause(uid, d)}
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
  days,
  granularity,
}: {
  userId: number;
  days: number;
  granularity: Granularity;
}): Promise<EarningsPoint[]> {
  const uid = Number(userId);
  const d = Number(days);
  const bucket = granularity === 'week' ? 'toStartOfWeek(date, 1)' : 'toDate(date)';
  const rows = await getClickhouse().$query<{
    date: string;
    source: EarningsSource;
    total: number | string;
  }>(
    `SELECT ${bucket} AS date, ${SOURCE_EXPR} AS source, sum(amount) AS total
     FROM default.buzzTransactions
     WHERE ${whereClause(uid, d)} AND toAccountType IN ('yellow','blue','green','club')
     GROUP BY date, source
     ORDER BY date`
  );
  return rows.map((r) => ({ date: String(r.date), source: r.source, total: Number(r.total) }));
}

// By-source × currency totals over the window — the /earnings source cards and the dashboard headline.
export const getEarningsSummary = createCache({
  name: 'earnings:summary',
  fetch: fetchSummary,
  ttlSeconds: ({ days }) => rangeTtlSeconds(days),
}).get;

// Per-currency totals over time (one series per currency; sources summed) — the /earnings trend chart.
export const getEarningsSeries = createCache({
  name: 'earnings:series',
  fetch: fetchSeries,
  ttlSeconds: ({ days }) => rangeTtlSeconds(days),
}).get;
