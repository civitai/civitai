import { sql } from '@civitai/db/kysely';
import { dbRead } from '$lib/server/db';
import { getClickhouse } from '$lib/server/clickhouse';
import { createCache } from '$lib/server/cache';
import { eachDayIso, rangeTtlSeconds, type DateRange } from '$lib/date-range';
import { BUZZ_CURRENCIES } from '$lib/earnings';
import { accessKindExpression } from '$lib/monetization/access-kind';
import {
  ADOPTION_KINDS,
  MONETIZATION_CHANNELS,
  type AdoptionKind,
  type MonetizationChannel,
} from '$lib/monetization/admin-channels';

// Platform-wide monetization overview for the admin panel: how many versions carry each monetization
// setting today (Postgres, a snapshot) and what money moved through each channel over a range
// (ClickHouse). Both are whole-platform reads with no owner filter — the /admin layout is what gates them.

export type AdoptionRow = {
  kind: AdoptionKind;
  versions: number;
  models: number;
  creators: number;
};

// Per-currency totals for one side of one channel. Currencies are the raw account types and are never
// converted or merged across families (B8 / D1) — yellow, blue, green and cash sit side by side.
export type ChannelCurrencyTotal = { currency: string; total: number; transactions: number };

export type ChannelMoney = {
  channel: MonetizationChannel;
  // What buyers paid, keyed by the currency they SPENT. Empty for a minted channel (see CHANNEL_SPEND):
  // the fee is charged inside the generation cost, which no table splits — unknown, not zero.
  spent: ChannelCurrencyTotal[];
  // What creators received, keyed by the currency they were CREDITED. A green purchase can settle to the
  // seller as yellow, so the two sides do not agree currency-by-currency even when the totals match.
  paidOut: ChannelCurrencyTotal[];
  transactions: number;
  creators: number;
  buyers: number;
};

// A version's monetization settings as they stand right now. `PaidAccess` discriminates timed from
// permanent on `timeframeDays`, never on `endsAt` — a NULL `endsAt` means either a permanent gate or a
// timed window that has not been published yet, which is why the timed gates split three ways: pending,
// open, and elapsed. Expiry never deletes the row, so an elapsed window is a tombstone, not a live gate.
//
// Deleting a model leaves its `PaidAccess`, `DonationGoal` and `licensingFee` untouched, so every branch
// has to exclude deleted models or the snapshot keeps counting settings nobody can reach — the same
// filter every sibling read in this app applies. Version STATUS is deliberately not filtered: a fee set
// on a draft is a setting in use.
const NOT_DELETED = sql`m."deletedAt" is null`;
const ADOPTION_SQL = sql<{
  kind: AdoptionKind;
  versions: number;
  models: number;
  creators: number;
}>`
  with goal as (
    select
      dg.active,
      coalesce(
        case when dg."entityType" = 'ModelVersion' then dg."entityId" end,
        dg."modelVersionId"
      ) as "versionId"
    from "DonationGoal" dg
  ),
  gate as (
    select pa."timeframeDays", pa."endsAt", pa."entityId" as "versionId"
    from "PaidAccess" pa
    where pa."entityType" = 'ModelVersion'
  )
  select 'licenseFee' as kind,
         count(distinct mv.id)::int as versions,
         count(distinct mv."modelId")::int as models,
         count(distinct m."userId")::int as creators
    from "ModelVersion" mv
    join "Model" m on m.id = mv."modelId"
   where mv."licensingFee" > 0 and ${NOT_DELETED}
  union all
  select 'permanentAccess',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from gate g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where g."timeframeDays" is null and ${NOT_DELETED}
  union all
  select 'earlyAccessPending',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from gate g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where g."timeframeDays" is not null and g."endsAt" is null and ${NOT_DELETED}
  union all
  select 'earlyAccessActive',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from gate g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where g."timeframeDays" is not null and g."endsAt" > now() and ${NOT_DELETED}
  union all
  select 'earlyAccessExpired',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from gate g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where g."timeframeDays" is not null and g."endsAt" <= now() and ${NOT_DELETED}
  union all
  select 'donationGoalActive',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from goal g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where g.active and ${NOT_DELETED}
  union all
  select 'donationGoalClosed',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from goal g
    join "ModelVersion" mv on mv.id = g."versionId"
    join "Model" m on m.id = mv."modelId"
   where not g.active and ${NOT_DELETED}
  union all
  -- Deduplicated across every setting. The rows above overlap by design — a version can carry a fee, a
  -- gate and a goal at once — so the headline count has to be its own DISTINCT, never a max or a sum of
  -- them. Taking the largest single row undercounts anyone whose only setting is a smaller category.
  select 'anySetting',
         count(distinct mv.id)::int, count(distinct mv."modelId")::int, count(distinct m."userId")::int
    from "ModelVersion" mv
    join "Model" m on m.id = mv."modelId"
    left join gate g on g."versionId" = mv.id
    left join goal dg on dg."versionId" = mv.id
   where ${NOT_DELETED}
     and (mv."licensingFee" > 0 or g."versionId" is not null or dg."versionId" is not null)
`;

async function fetchAdoption(): Promise<AdoptionRow[]> {
  const { rows } = await ADOPTION_SQL.execute(dbRead);
  return rows.map((r) => ({
    kind: r.kind,
    versions: Number(r.versions),
    models: Number(r.models),
    creators: Number(r.creators),
  }));
}

// 🔴 Payloads name their rows and both pages look each row up by name, so a payload missing a
// newly-added name renders as a zero row rather than an error. Treat that as a miss and re-read.
async function vocabularyChecked<A, T>(
  cache: { get(args: A): Promise<T>; bust(args: A): Promise<void> },
  args: A,
  covers: (value: T) => boolean
): Promise<T> {
  const value = await cache.get(args);
  if (covers(value)) return value;
  await cache.bust(args);
  return cache.get(args);
}

const adoptionCache = createCache({
  // A snapshot, not a time series — a short TTL is enough to keep the union off the replica per page view.
  name: 'admin:monetization:adoption:v3',
  fetch: fetchAdoption,
  ttlSeconds: 600,
});

export const getMonetizationAdoption = (args: Record<string, never>) =>
  vocabularyChecked(adoptionCache, args, (rows) =>
    ADOPTION_KINDS.every((k) => rows.some((r) => r.kind === k))
  );

// The version a `<early|permanent>-access-<versionId>-…` id names.
const VERSION_ID_EXPR = `toUInt32OrNull(splitByChar('-', externalTransactionId)[3])`;

// `licenseFee` also matches the mislabelled `'27'` rows — an upstream ingest bug that writes the numeric
// TransactionType instead of its name. Access sales carry both id prefixes because rows written before
// the products were split are `early-access-` whichever one they were; accessKindExpression settles what
// it can from the id, description and dates, and the rows it cannot are resolved from the gate the
// version carries NOW — the same rule `resolveAccessKind` applies on the per-creator pages, so the two
// report the same split. An empty set means nothing needed resolving.
function channelExpr(permanentVersionIds: number[]) {
  const resolveUnknown = permanentVersionIds.length
    ? `${VERSION_ID_EXPR} IN (${permanentVersionIds.join(',')}), 'permanentAccess', 'earlyAccess'`
    : `1, 'earlyAccess', 'earlyAccess'`;
  // Shop rows are matched BEFORE the access branches: a `cosmetic-purchase-…` row is also
  // `type = 'purchase'`, so leaving it to fall through would file Creator Shop revenue under access
  // sales. Both sides of a shop sale share the buy id — the payout appends `:sell:<user>:<color>` — so
  // one prefix per product covers the buyer row and the creator row together.
  return `multiIf(
    type IN ('licenseFee','27'), 'licenseFee',
    type = 'donation', 'donation',
    ${SHOP_ROWS}, 'cosmeticShop',
    ${accessKindExpression} != 'unknown', ${accessKindExpression},
    ${resolveUnknown})`;
}

// The access and donation branches gate on `type` too, matching `earnings.ts` — a refund reuses the
// purchase's own id prefix and would otherwise count as a second sale.
//
// The shop is matched on both legs. The payout leg is `type = 'sell'`, which is what `earnings.ts` uses
// and the only complete test: payout ids only gained the `cosmetic-…:sell:` shape in Aug 2026, so a
// prefix-only match drops every earlier sale — 762 rows across the trailing year, and every month before
// August entirely. The buyer leg has no equivalent marker and must go on the prefixes, so spend before
// Aug 2026 is unattributable where its payout is not. `creator-shop-submit-` stays out: a listing fee is
// a cost creators pay, not a sale.
const SHOP_BUY_PREFIXES = `(externalTransactionId LIKE 'cosmetic-purchase-%'
                        OR externalTransactionId LIKE 'cosmetic-pack-%')`;
const SHOP_ROWS = `(type = 'sell' OR (type = 'purchase' AND ${SHOP_BUY_PREFIXES}))`;

// 🔴 `externalTransactionId` was only written from 2025-10-13; every access sale and donation before that
// carries an empty string. Matching on the id alone therefore reports ⚡12-18M/month of real 2025 sales as
// zero — and the month picker offers 18 months, so those months are reachable. The description is the only
// discriminator that survives back there (`type` alone would sweep in gifts and top-ups), and it is safe:
// `Gain access to model%` has no rows before permanent access existed, so it cannot backdate that product.
//
// Donations get no such fallback on purpose. 117k `donation` rows are charity-campaign donations with their
// own ids, and a pre-cutover goal donation is indistinguishable from one — so goal donations before the
// cutover are dropped rather than guessed. The page says so.
const ACCESS_ROWS = `(type = 'purchase' AND (externalTransactionId LIKE 'early-access-%'
                            OR externalTransactionId LIKE 'permanent-access-%'
                            OR description LIKE 'Gain early access%'
                            OR description LIKE 'Gain access to model%'))`;

const CHANNEL_FILTER = `(
    ${ACCESS_ROWS}
    OR (type = 'donation' AND externalTransactionId LIKE 'donation-%')
    OR type IN ('licenseFee','27')
    OR ${SHOP_ROWS}
  )`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The range is interpolated, so it is checked here rather than trusted from the caller. `date` is a
// DateTime, so the upper bound is the day after `to` to take the whole of the last day.
function bounds({ from, to }: DateRange) {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) throw new Error('Invalid range');
  return `date >= toDate('${from}') AND date < toDate('${to}') + 1`;
}

type MoneyRow = {
  channel: MonetizationChannel;
  payoutCurrency: string;
  spendCurrency: string;
  minted: number;
  toBank: number;
  total: number | string;
  transactions: number | string;
};
type PartyRow = {
  channel: MonetizationChannel;
  creators: number | string;
  buyers: number | string;
};

const emptyChannel = (channel: MonetizationChannel): ChannelMoney => ({
  channel,
  spent: [],
  paidOut: [],
  transactions: 0,
  creators: 0,
  buyers: 0,
});

function addCurrency(list: ChannelCurrencyTotal[], currency: string, total: number, txs: number) {
  const existing = list.find((c) => c.currency === currency);
  if (existing) {
    existing.total += total;
    existing.transactions += txs;
    return;
  }
  list.push({ currency, total, transactions: txs });
}

// Which versions sold access in this range that the ledger cannot name a product for. The ambiguous
// window is closed and in the past, so for any range that misses it this is empty and no lookup runs.
async function unresolvedAccessVersionIds(where: string): Promise<number[]> {
  const rows = await getClickhouse().$query<{ modelVersionId: number | string | null }>(
    `SELECT DISTINCT ${VERSION_ID_EXPR} AS modelVersionId
       FROM default.buzzTransactions
      WHERE ${where} AND ${accessKindExpression} = 'unknown'
     HAVING modelVersionId IS NOT NULL`
  );
  return rows.map((r) => Number(r.modelVersionId)).filter(Number.isInteger);
}

// Of those, the ones gated permanently today. A version selling permanently now never ran a timed window
// for the ledger to have been describing; one with no gate at all falls back to early access.
async function permanentlyGated(versionIds: number[]): Promise<number[]> {
  if (versionIds.length === 0) return [];
  const rows = await dbRead
    .selectFrom('PaidAccess')
    .where('entityType', '=', 'ModelVersion')
    .where('entityId', 'in', versionIds)
    .where('timeframeDays', 'is', null)
    .select('entityId')
    .execute();
  return rows.map((r) => Number(r.entityId));
}

async function fetchMoney(range: DateRange): Promise<ChannelMoney[]> {
  const where = `${bounds(range)} AND ${CHANNEL_FILTER}`;
  const ch = getClickhouse();
  const CHANNEL_EXPR = channelExpr(await permanentlyGated(await unresolvedAccessVersionIds(where)));
  // Two reads rather than one: the distinct-party counts cannot be summed out of the currency-grouped
  // rows without double-counting anyone who transacted in more than one currency.
  const [rows, parties] = await Promise.all([
    ch.$query<MoneyRow>(
      `SELECT ${CHANNEL_EXPR} AS channel,
              toAccountType AS payoutCurrency,
              fromAccountType AS spendCurrency,
              fromAccountId = 0 AS minted,
              toAccountId = 0 AS toBank,
              sum(amount) AS total,
              count() AS transactions
         FROM default.buzzTransactions
        WHERE ${where}
        GROUP BY channel, payoutCurrency, spendCurrency, minted, toBank`
    ),
    ch.$query<PartyRow>(
      `SELECT ${CHANNEL_EXPR} AS channel,
              uniqExactIf(toAccountId, toAccountId != 0) AS creators,
              uniqExactIf(fromAccountId, fromAccountId != 0) AS buyers
         FROM default.buzzTransactions
        WHERE ${where}
        GROUP BY channel`
    ),
  ]);

  const byChannel = new Map<MonetizationChannel, ChannelMoney>(
    MONETIZATION_CHANNELS.map((c) => [c, emptyChannel(c)])
  );
  for (const r of rows) {
    const entry = byChannel.get(r.channel);
    if (!entry) continue;
    const total = Number(r.total);
    const txs = Number(r.transactions);
    // Money moving TO the bank is not money paid to a creator — it is the buyer's side of a split sale.
    // Counting it would report the Creator Shop paying out the full price and hide the platform's cut.
    if (!Number(r.toBank)) addCurrency(entry.paidOut, r.payoutCurrency, total, txs);
    // A minted row has no payer: on a split sale it is the platform paying the creator, and on a license
    // fee the buyer was charged inside the generation cost. Either way there is no buyer spend to book.
    if (!Number(r.minted)) addCurrency(entry.spent, r.spendCurrency, total, txs);
    // Payout legs only, so the column means the same thing on every row. A shop sale is two rows (buy +
    // payout) where an access sale is one, and summing both made the shop look like the busiest channel
    // by volume purely because its sales are counted twice.
    if (!Number(r.toBank)) entry.transactions += txs;
  }
  for (const p of parties) {
    const entry = byChannel.get(p.channel);
    if (!entry) continue;
    entry.creators = Number(p.creators);
    entry.buyers = Number(p.buyers);
  }
  return [...byChannel.values()];
}

const moneyCache = createCache({
  // The key is prefix:name:args, so a stored value outlives a change to the returned shape — bump the
  // suffix when the shape or the channel names change.
  name: 'admin:monetization:money:v5',
  fetch: fetchMoney,
  ttlSeconds: (range: DateRange) => rangeTtlSeconds(range),
});

export const getMonetizationMoney = (range: DateRange) =>
  vocabularyChecked(moneyCache, range, (rows) =>
    MONETIZATION_CHANNELS.every((c) => rows.some((r) => r.channel === c))
  );

// A day's payout per channel over one range. Buzz families only: cash cannot share a y-axis with buzz,
// and adding them would be the currency merge B8/D1 forbids — the table keeps cash visible, the chart
// does not plot it.
export type MonetizationDaily = {
  // Every calendar day in the range, so a partial month still draws its full width and the line simply
  // stops where the data does — rather than a short month reading as a decline.
  days: string[];
  // Per channel, one payout total per day, index-aligned to `days`.
  series: { channel: MonetizationChannel; totals: number[] }[];
  // Cash paid over the same range, reported beside the chart rather than plotted.
  cash: { currency: string; total: number }[];
  // The latest day in this range the ledger actually has a row for. The chart stops here.
  through: string | null;
};

const BUZZ_LIST = BUZZ_CURRENCIES.map((c) => `'${c}'`).join(',');

async function fetchDaily(range: DateRange): Promise<MonetizationDaily> {
  const days = eachDayIso(range);
  const where = `${bounds(range)} AND ${CHANNEL_FILTER}`;
  const ch = getClickhouse();
  const CHANNEL_EXPR = channelExpr(await permanentlyGated(await unresolvedAccessVersionIds(where)));

  // `toAccountId != 0` on all three: money moving to the bank is a buyer's leg, not a payout.
  const [rows, cashRows, throughRows] = await Promise.all([
    ch.$query<{ day: string; channel: MonetizationChannel; total: number | string }>(
      `SELECT formatDateTime(toDate(date), '%Y-%m-%d') AS day,
              ${CHANNEL_EXPR} AS channel,
              sum(amount) AS total
         FROM default.buzzTransactions
        WHERE ${where} AND toAccountId != 0 AND toAccountType IN (${BUZZ_LIST})
        GROUP BY day, channel`
    ),
    ch.$query<{ currency: string; total: number | string }>(
      `SELECT toAccountType AS currency, sum(amount) AS total
         FROM default.buzzTransactions
        WHERE ${where} AND toAccountId != 0 AND toAccountType NOT IN (${BUZZ_LIST})
        GROUP BY currency`
    ),
    ch.$query<{ through: string | null }>(
      `SELECT formatDateTime(max(date), '%Y-%m-%d') AS through
         FROM default.buzzTransactions
        WHERE ${where}`
    ),
  ]);

  const index = new Map(days.map((d, i) => [d, i]));
  const series = MONETIZATION_CHANNELS.map((channel) => ({ channel, totals: days.map(() => 0) }));
  for (const r of rows) {
    const i = index.get(String(r.day));
    const entry = series.find((s) => s.channel === r.channel);
    if (i === undefined || !entry) continue;
    entry.totals[i] = Number(r.total);
  }

  const through = throughRows[0]?.through ?? null;
  return {
    days,
    series,
    cash: cashRows.map((c) => ({ currency: c.currency, total: Number(c.total) })),
    // ClickHouse formats max(date) over no rows as 1970-01-01; report no through-date instead.
    through: through && through !== '1970-01-01' ? through : null,
  };
}

const dailyCache = createCache({
  name: 'admin:monetization:daily:v1',
  fetch: fetchDaily,
  ttlSeconds: (range: DateRange) => rangeTtlSeconds(range),
});

export const getMonetizationDaily = (range: DateRange) =>
  vocabularyChecked(dailyCache, range, (d) =>
    MONETIZATION_CHANNELS.every((c) => d.series.some((s) => s.channel === c))
  );
