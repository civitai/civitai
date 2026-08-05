import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';
import { currencyMeta } from '$lib/earnings';

// Per-model earnings — A1 **Part 2**. Reads `orchestration.resourceCompensations`, where the orchestrator now
// stamps the owner `userId` onto every row (backfilled to 2024-08), so "this creator's models" is a cheap `userId`
// filter — no `modelVersionId → owner` dictionary. The table is a `SharedSummingMergeTree`, so always
// `sum(amount)` + `GROUP BY` at read time. `amount` is fractional Float64; `accountType` is Capitalized
// (`Yellow`/`Blue`/`Green`/`CashSettled`) unlike `buzzTransactions`, so we lower-first it onto the shared currency
// vocabulary. Currencies are never converted or merged across families (B8). Rationale + schema:
// docs/creator-studio/licensing-fee-owner-stamping.md (in the main app).

// `prev` = the same currency's total in the previous equal-length period (for delta chips); set by
// getModelPerformance / getModelVersionAnalytics, left undefined by getModelEarnings.
export type ModelCurrencyTotal = { currency: string; total: number; prev?: number };

// deliver-creator-compensation buckets on exactly this rule: licenseFee mints its own transaction and
// EVERY other source merges into one compensation payout. Match its `!== 'licenseFee'` rather than naming
// known sources, so a new or one-off source value lands in a total instead of vanishing from the split.
const payoutChannel = (source: string) => (source === 'licenseFee' ? 'licenseFee' : 'compensation');
export type ModelEarning = {
  modelVersionId: number;
  versionName: string | null;
  modelId: number | null;
  modelName: string | null;
  modelType: string | null;
  // Model NSFW flag — drives whether the link points at civitai.red (mature) vs civitai.com.
  nsfw: boolean;
  // Per-currency totals, kept split across families (buzz + cash) — never summed together.
  currencies: ModelCurrencyTotal[];
  // Sum of buzz-family currencies only — the ranking / glance number (mirrors the dashboard's "Buzz earned").
  buzzTotal: number;
};

// Per-model performance = earnings + usage (generation & download counts). The usage tables are keyed by
// modelVersionId with **no owner column**, so — per Justin — we resolve the creator's version ids from Postgres
// and filter the usage tables by that id list rather than owner-stamping them. Generations come from
// `orchestration.daily_resource_generation_counts` (the live, full-volume table; the `default.*` MV copy
// undercounts ~200x); downloads from `default.daily_downloads`. Both carry garbage future-dated rows, so the
// window is capped at today().
// The five ways a model earns, as separate columns on /analytics/models. `licenseFee` + `compensation`
// come from resourceCompensations; the other three are buyer-funded and only exist in buzzTransactions.
export const PERFORMANCE_CHANNELS = [
  'licenseFee',
  'compensation',
  'earlyAccess',
  'permanentAccess',
  'donation',
] as const;
export type PerformanceChannel = (typeof PERFORMANCE_CHANNELS)[number];

// `prev` is carried per currency, not just per channel, so the currency filter chips can recompute a
// correct delta for the selected subset instead of showing a delta for the unfiltered total.
export type ChannelCurrency = { currency: string; total: number; prev: number };
export type ChannelTotals = {
  // Buzz-family totals across every currency — the unfiltered column value.
  total: number;
  prev: number;
  // What the CREATOR was credited, by account type. The filter chips sum a subset of this.
  // NOTE: `createMultiAccountBuzzTransaction` defaults the credit to yellow, so on the buyer-funded
  // channels (access sales, donations) this is always yellow whatever the buyer actually paid with.
  received: ChannelCurrency[];
};

export type ModelPerformance = ModelEarning & {
  generations: number;
  prevGenerations: number;
  downloads: number;
  prevDownloads: number;
  channels: Record<PerformanceChannel, ChannelTotals>;
  prevBuzzTotal: number;
};

const emptyChannel = (): ChannelTotals => ({ total: 0, prev: 0, received: [] });
const emptyChannels = (): Record<PerformanceChannel, ChannelTotals> =>
  Object.fromEntries(PERFORMANCE_CHANNELS.map((c) => [c, emptyChannel()])) as Record<
    PerformanceChannel,
    ChannelTotals
  >;

function addChannelCurrency(
  list: ChannelCurrency[],
  currency: string,
  total: number,
  prev: number
) {
  const existing = list.find((c) => c.currency === currency);
  if (existing) {
    existing.total += total;
    existing.prev += prev;
  } else list.push({ currency, total, prev });
}

// Cap on versions resolved + returned; bounds the Postgres enrichment and the table length.
const TOP_N = 100;

// The table is written by the external .NET orchestrator and carries known garbage rows (binary-junk accountType,
// absurd amounts up to ~2e267). A letters-only accountType + a sane amount bound keep those out of the sum.
const CORRUPT_FILTER = `match(accountType, '^[A-Za-z]+$') AND amount > 0 AND amount < 1e12`;

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// The buyer-funded folds add to a currency the compensation fold may already have created, and the access
// query's `accessKind` dimension splits one currency across rows — so merge, never push.
function addCurrency(
  entry: { currencies: ModelCurrencyTotal[] },
  currency: string,
  total: number,
  prev: number
) {
  const existing = entry.currencies.find((c) => c.currency === currency);
  if (existing) {
    existing.total += total;
    existing.prev = (existing.prev ?? 0) + prev;
  } else entry.currencies.push({ currency, total, prev });
}

type Window = { from: string; to: string; prev: { from: string; to: string } };
type BuyerFundedRow = { accountType: string; cur: number | string; prev: number | string };
type AccessRow = BuyerFundedRow & { modelVersionId: number | string; accessKind: string };
type DonationRow = BuyerFundedRow & { goalId: number | string };

// Half-open windows, unlike the resourceCompensations reads: `buzzTransactions.date` is a DateTime, so an
// inclusive `toDate(to) + 1` upper bound would put midnight in both the current and previous window.
const windowSums = (w: Window) =>
  `sumIf(amount, date >= toDate('${w.from}') AND date < toDate('${w.to}') + 1) AS cur,
     sumIf(amount, date >= toDate('${w.prev.from}') AND date < toDate('${w.prev.to}') + 1) AS prev`;

const windowBounds = (w: Window) =>
  `date >= toDate('${w.prev.from}') AND date < toDate('${w.to}') + 1`;

// Access sales never reach resourceCompensations — the buyer pays the creator directly, so the
// buzzTransactions row is the only record. Id shape:
// `<early|permanent>-access-<versionId>-<download|generation>-<buyerId>-<accountType>`. Both prefixes must
// be matched: rows predating the split are `early-access-` whichever product they were.
function accessSalesQuery(uid: number, w: Window, versionIdList?: string) {
  return `SELECT toUInt32OrNull(splitByChar('-', externalTransactionId)[3]) AS modelVersionId,
       multiIf(
         externalTransactionId LIKE 'permanent-access-%', 'permanentAccess',
         description LIKE 'Gain access to model%', 'permanentAccess',
         'earlyAccess'
       ) AS accessKind,
       toAccountType AS accountType,
       ${windowSums(w)}
     FROM buzzTransactions
     WHERE toAccountId = ${uid}
       AND type = 'purchase'
       AND (externalTransactionId LIKE 'early-access-%'
            OR externalTransactionId LIKE 'permanent-access-%')
       AND ${windowBounds(w)}
     GROUP BY modelVersionId, accessKind, accountType
     HAVING modelVersionId IS NOT NULL${versionIdList ? ` AND modelVersionId IN (${versionIdList})` : ''}`;
}

// Donations are keyed by goal (`donation-<goalId>-<ts>`), so the goal→version map comes from Postgres.
function donationsQuery(uid: number, w: Window, goalIds: number[]) {
  return `SELECT toUInt32OrNull(splitByChar('-', externalTransactionId)[2]) AS goalId,
       toAccountType AS accountType,
       ${windowSums(w)}
     FROM buzzTransactions
     WHERE toAccountId = ${uid}
       AND type = 'donation'
       AND externalTransactionId LIKE 'donation-%'
       AND ${windowBounds(w)}
     GROUP BY goalId, accountType
     HAVING goalId IN (${goalIds.join(',')})`;
}

// The goal target is the polymorphic (entityType, entityId) pair; `modelVersionId` is the legacy column
// being dual-written until the re-key migration drops it, so it's only a fallback for older rows.
async function donationGoalVersions(uid: number, versionIds?: number[]) {
  const rows = await dbRead
    .selectFrom('DonationGoal')
    .where('userId', '=', uid)
    .where((eb) =>
      eb.or([
        eb.and([eb('entityType', '=', 'ModelVersion'), eb('entityId', 'is not', null)]),
        eb('modelVersionId', 'is not', null),
      ])
    )
    .select(['id', 'entityType', 'entityId', 'modelVersionId'])
    .execute();
  const scope = versionIds ? new Set(versionIds) : null;
  const byGoal = new Map<number, number>();
  for (const g of rows) {
    const versionId =
      g.entityType === 'ModelVersion' && g.entityId != null ? Number(g.entityId) : g.modelVersionId;
    if (versionId == null) continue;
    if (scope && !scope.has(Number(versionId))) continue;
    byGoal.set(Number(g.id), Number(versionId));
  }
  return byGoal;
}

async function fetchModelEarnings({
  userId,
  from,
  to,
}: {
  userId: number;
  from: string;
  to: string;
}): Promise<ModelEarning[]> {
  const uid = Number(userId);

  const rows = await getClickhouse().$query<{
    modelVersionId: number | string;
    accountType: string;
    total: number | string;
  }>(
    `SELECT modelVersionId, accountType, sum(amount) AS total
     FROM orchestration.resourceCompensations
     WHERE userId = ${uid} AND date >= toDate('${from}') AND date <= toDate('${to}') AND ${CORRUPT_FILTER}
     GROUP BY modelVersionId, accountType`
  );

  const byVersion = new Map<number, ModelEarning>();
  for (const r of rows) {
    const versionId = Number(r.modelVersionId);
    const currency = lowerFirst(r.accountType);
    const total = Number(r.total);
    let entry = byVersion.get(versionId);
    if (!entry) {
      entry = {
        modelVersionId: versionId,
        versionName: null,
        modelId: null,
        modelName: null,
        modelType: null,
        nsfw: false,
        currencies: [],
        buzzTotal: 0,
      };
      byVersion.set(versionId, entry);
    }
    entry.currencies.push({ currency, total });
    if (currencyMeta(currency).family === 'buzz') entry.buzzTotal += total;
  }

  const rawTotal = (m: ModelEarning) => m.currencies.reduce((s, c) => s + c.total, 0);
  const ranked = [...byVersion.values()]
    .sort((a, b) => b.buzzTotal - a.buzzTotal || rawTotal(b) - rawTotal(a))
    .slice(0, TOP_N);

  // Stable currency order within each model (buzz first, then by known order).
  for (const m of ranked) {
    m.currencies.sort((a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order);
  }

  return enrichModels(ranked);
}

// Resolve version/model name + model type from Postgres for display. Versions whose model was deleted keep null
// names (still shown by id) rather than being dropped.
async function enrichModels(models: ModelEarning[]): Promise<ModelEarning[]> {
  const ids = models.map((m) => m.modelVersionId);
  if (!ids.length) return models;
  const rows = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('mv.id', 'in', ids)
    .select([
      'mv.id as versionId',
      'mv.name as versionName',
      'm.id as modelId',
      'm.name as modelName',
      'm.type as modelType',
      'm.nsfw as nsfw',
    ])
    .execute();
  const byId = new Map(rows.map((r) => [Number(r.versionId), r]));
  return models.map((m) => {
    const row = byId.get(m.modelVersionId);
    if (!row) return m;
    return {
      ...m,
      versionName: row.versionName ?? null,
      modelId: Number(row.modelId),
      modelName: row.modelName ?? null,
      modelType: (row.modelType as string) ?? null,
      nsfw: !!row.nsfw,
    };
  });
}

// Top models by buzz earnings over the window — the dashboard "top-earning model" tile and the /analytics
// per-model table both read this (dashboard takes the first entry, analytics lists them).
export const getModelEarnings = createCache({
  name: 'earnings:by-model',
  fetch: fetchModelEarnings,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

async function fetchModelPerformance({
  userId,
  from,
  to,
  compareFrom,
  compareTo,
}: {
  userId: number;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
}): Promise<ModelPerformance[]> {
  const uid = Number(userId);

  // The creator's whole catalog (Postgres) — the universe + enrichment. The usage tables have no owner column, so
  // this id list is how we scope them to this creator.
  const versions = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('m.userId', '=', uid)
    .select([
      'mv.id as versionId',
      'mv.name as versionName',
      'm.id as modelId',
      'm.name as modelName',
      'm.type as modelType',
      'm.nsfw as nsfw',
    ])
    .execute();
  if (!versions.length) return [];

  const versionByGoal = await donationGoalVersions(uid);

  const idList = versions.map((v) => Number(v.versionId)).join(',');
  // daily_downloads is sorted by (modelId, modelVersionId, …) and unpartitioned, so filtering on modelVersionId
  // alone full-scans it. Also constrain modelId (the sort-key leader) so the read seeks straight to these models.
  const modelIdList = [...new Set(versions.map((v) => Number(v.modelId)))].join(',');

  const prev = { from: compareFrom, to: compareTo };
  const w: Window = { from, to, prev };
  const ch = getClickhouse();
  // Each query sums the current + previous window (for the delta chips); `to` also fences out garbage future rows.
  const [earnRows, genRows, dlRows, accessRows, donationRows] = await Promise.all([
    ch.$query<{
      modelVersionId: number | string;
      accountType: string;
      source: string;
      cur: number | string;
      prev: number | string;
    }>(
      `SELECT modelVersionId, accountType, source,
         sumIf(amount, date BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(amount, date BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.resourceCompensations
       WHERE userId = ${uid} AND date BETWEEN toDate('${prev.from}') AND toDate('${to}') AND ${CORRUPT_FILTER}
       GROUP BY modelVersionId, accountType, source`
    ),
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(count, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(count, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.daily_resource_generation_counts
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(downloads, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(downloads, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM default.daily_downloads
       WHERE modelId IN (${modelIdList}) AND modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<AccessRow>(accessSalesQuery(uid, w)),
    versionByGoal.size === 0
      ? Promise.resolve([] as DonationRow[])
      : ch.$query<DonationRow>(donationsQuery(uid, w, [...versionByGoal.keys()])),
  ]);

  const byId = new Map<number, ModelPerformance>();
  for (const v of versions) {
    byId.set(Number(v.versionId), {
      modelVersionId: Number(v.versionId),
      versionName: v.versionName ?? null,
      modelId: Number(v.modelId),
      modelName: v.modelName ?? null,
      modelType: (v.modelType as string) ?? null,
      nsfw: !!v.nsfw,
      currencies: [],
      channels: emptyChannels(),
      buzzTotal: 0,
      prevBuzzTotal: 0,
      generations: 0,
      prevGenerations: 0,
      downloads: 0,
      prevDownloads: 0,
    });
  }
  for (const r of earnRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (!e) continue;
    const currency = lowerFirst(r.accountType);
    const total = Number(r.cur);
    const prevTotal = Number(r.prev);
    addCurrency(e, currency, total, prevTotal);
    if (currencyMeta(currency).family === 'buzz') {
      e.buzzTotal += total;
      e.prevBuzzTotal += prevTotal;
      const bucket = e.channels[payoutChannel(r.source)];
      bucket.total += total;
      bucket.prev += prevTotal;
      addChannelCurrency(bucket.received, currency, total, prevTotal);
    }
  }
  for (const r of genRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (e) {
      e.generations = Number(r.cur);
      e.prevGenerations = Number(r.prev);
    }
  }
  for (const r of dlRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (e) {
      e.downloads = Number(r.cur);
      e.prevDownloads = Number(r.prev);
    }
  }
  // addCurrency runs BEFORE the buzz-family return: the `active` filter tests `currencies`, so a model
  // that earned only via a sale or donation would otherwise be dropped from the table entirely.
  const addBuyerFunded = (
    versionId: number,
    channel: PerformanceChannel,
    accountType: string,
    cur: number,
    prev: number
  ) => {
    const e = byId.get(versionId);
    if (!e) return;
    const currency = lowerFirst(accountType);
    addCurrency(e, currency, cur, prev);
    if (currencyMeta(currency).family !== 'buzz') return;
    e.buzzTotal += cur;
    e.prevBuzzTotal += prev;
    const bucket = e.channels[channel];
    bucket.total += cur;
    bucket.prev += prev;
    addChannelCurrency(bucket.received, currency, cur, prev);
  };

  for (const r of accessRows)
    addBuyerFunded(
      Number(r.modelVersionId),
      r.accessKind as PerformanceChannel,
      r.accountType,
      Number(r.cur),
      Number(r.prev)
    );
  for (const r of donationRows) {
    const versionId = versionByGoal.get(Number(r.goalId));
    if (versionId === undefined) continue;
    addBuyerFunded(versionId, 'donation', r.accountType, Number(r.cur), Number(r.prev));
  }

  for (const e of byId.values())
    for (const c of PERFORMANCE_CHANNELS)
      e.channels[c].received.sort(
        (a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order
      );

  const active = [...byId.values()].filter(
    (m) => m.generations > 0 || m.downloads > 0 || m.currencies.some((c) => c.total > 0)
  );
  // Rank by usage first (this is a performance view), then earnings — so a popular free model still surfaces.
  active.sort(
    (a, b) =>
      b.generations - a.generations || b.downloads - a.downloads || b.buzzTotal - a.buzzTotal
  );
  for (const m of active) {
    m.currencies.sort((a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order);
  }
  // No cap — the /analytics/models table paginates client-side over the full set.
  return active;
}

// Per-model performance (earnings + usage) for the /analytics table. Earnings are owner-keyed; usage is scoped by
// the creator's version ids (the usage tables have no owner column — Justin's recommendation).
export const getModelPerformance = createCache({
  // Keys derive from the args, not the payload shape, so a stored value outlives a change to what this
  // returns. Bump the suffix whenever the returned shape changes.
  name: 'models:performance:v2',
  fetch: fetchModelPerformance,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Per-version analytics for a single model (feedback 4.5) — generations / downloads / buzz per version over the
// selected range, plus the previous equal-length period (for % deltas, like the earnings page). Ownership is
// enforced from Postgres (the model must belong to the caller); returns null when it doesn't exist or isn't theirs.
export type VersionCurrency = { currency: string; total: number; prev: number };
export type VersionAnalytics = {
  versionId: number;
  versionName: string | null;
  baseModel: string | null;
  generations: number;
  prevGenerations: number;
  downloads: number;
  prevDownloads: number;
  currencies: VersionCurrency[];
  channels: Record<PerformanceChannel, ChannelTotals>;
  buzzTotal: number;
  prevBuzzTotal: number;
};
export type ModelVersionAnalytics = {
  modelId: number;
  modelName: string | null;
  nsfw: boolean;
  nsfwLevel: number;
  versions: VersionAnalytics[];
};

async function fetchModelVersionAnalytics({
  userId,
  modelId,
  from,
  to,
  compareFrom,
  compareTo,
}: {
  userId: number;
  modelId: number;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
}): Promise<ModelVersionAnalytics | null> {
  const uid = Number(userId);
  const mid = Number(modelId);

  const model = await dbRead
    .selectFrom('Model')
    .where('id', '=', mid)
    .select(['id', 'name', 'userId', 'nsfw', 'nsfwLevel'])
    .executeTakeFirst();
  if (!model || Number(model.userId) !== uid) return null; // not found, or not the caller's model

  const versions = await dbRead
    .selectFrom('ModelVersion')
    .where('modelId', '=', mid)
    .select(['id', 'name', 'baseModel'])
    .orderBy('createdAt', 'desc')
    .execute();

  const base: ModelVersionAnalytics = {
    modelId: mid,
    modelName: model.name ?? null,
    nsfw: !!model.nsfw,
    nsfwLevel: Number(model.nsfwLevel ?? 0),
    versions: versions.map((v) => ({
      versionId: Number(v.id),
      versionName: v.name ?? null,
      baseModel: v.baseModel ?? null,
      generations: 0,
      prevGenerations: 0,
      downloads: 0,
      prevDownloads: 0,
      currencies: [],
      channels: emptyChannels(),
      buzzTotal: 0,
      prevBuzzTotal: 0,
    })),
  };
  if (!versions.length) return base;

  const prev = { from: compareFrom, to: compareTo };
  const w: Window = { from, to, prev };
  const versionIds = versions.map((v) => Number(v.id));
  const idList = versionIds.join(',');
  const versionByGoal = await donationGoalVersions(uid, versionIds);
  const ch = getClickhouse();
  // One query per source, each summing the current + previous window (for the delta chips). The upper bound `to`
  // also fences out the tables' garbage future-dated rows.
  const [genRows, dlRows, earnRows, accessRows, donationRows] = await Promise.all([
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(count, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(count, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.daily_resource_generation_counts
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(downloads, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(downloads, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM default.daily_downloads
       WHERE modelId = ${mid} AND modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<{
      modelVersionId: number | string;
      accountType: string;
      source: string;
      cur: number | string;
      prev: number | string;
    }>(
      `SELECT modelVersionId, accountType, source,
         sumIf(amount, date BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(amount, date BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.resourceCompensations
       WHERE userId = ${uid} AND modelVersionId IN (${idList}) AND date BETWEEN toDate('${prev.from}') AND toDate('${to}') AND ${CORRUPT_FILTER}
       GROUP BY modelVersionId, accountType, source`
    ),
    ch.$query<AccessRow>(accessSalesQuery(uid, w, idList)),
    versionByGoal.size === 0
      ? Promise.resolve([] as DonationRow[])
      : ch.$query<DonationRow>(donationsQuery(uid, w, [...versionByGoal.keys()])),
  ]);

  const byId = new Map(base.versions.map((v) => [v.versionId, v]));
  for (const r of genRows) {
    const v = byId.get(Number(r.modelVersionId));
    if (v) {
      v.generations = Number(r.cur);
      v.prevGenerations = Number(r.prev);
    }
  }
  for (const r of dlRows) {
    const v = byId.get(Number(r.modelVersionId));
    if (v) {
      v.downloads = Number(r.cur);
      v.prevDownloads = Number(r.prev);
    }
  }
  for (const r of earnRows) {
    const v = byId.get(Number(r.modelVersionId));
    if (!v) continue;
    const currency = lowerFirst(r.accountType);
    const total = Number(r.cur);
    const prevTotal = Number(r.prev);
    addCurrency(v, currency, total, prevTotal);
    if (currencyMeta(currency).family === 'buzz') {
      v.buzzTotal += total;
      v.prevBuzzTotal += prevTotal;
      const bucket = v.channels[payoutChannel(r.source)];
      bucket.total += total;
      bucket.prev += prevTotal;
      addChannelCurrency(bucket.received, currency, total, prevTotal);
    }
  }
  // addCurrency runs before the buzz-family guard so a version that earned only from a sale or donation
  // still shows up in `currencies`.
  const addBuyerFunded = (
    versionId: number,
    channel: PerformanceChannel,
    accountType: string,
    cur: number,
    prevTotal: number
  ) => {
    const v = byId.get(versionId);
    if (!v) return;
    const currency = lowerFirst(accountType);
    addCurrency(v, currency, cur, prevTotal);
    if (currencyMeta(currency).family !== 'buzz') return;
    v.buzzTotal += cur;
    v.prevBuzzTotal += prevTotal;
    const bucket = v.channels[channel];
    bucket.total += cur;
    bucket.prev += prevTotal;
    addChannelCurrency(bucket.received, currency, cur, prevTotal);
  };
  for (const r of accessRows)
    addBuyerFunded(
      Number(r.modelVersionId),
      r.accessKind as PerformanceChannel,
      r.accountType,
      Number(r.cur),
      Number(r.prev)
    );
  for (const r of donationRows) {
    const versionId = versionByGoal.get(Number(r.goalId));
    if (versionId !== undefined)
      addBuyerFunded(versionId, 'donation', r.accountType, Number(r.cur), Number(r.prev));
  }

  for (const v of base.versions) {
    v.currencies.sort((a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order);
    for (const c of PERFORMANCE_CHANNELS)
      v.channels[c].received.sort(
        (a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order
      );
  }
  return base;
}

export const getModelVersionAnalytics = createCache({
  name: 'analytics:model-versions:v3',
  fetch: fetchModelVersionAnalytics,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Performance grouped by base model (feedback 4.6) — which ecosystems drive the creator's generations / downloads /
// buzz, with % deltas vs the previous period. Same per-version reads as getModelPerformance, aggregated by the
// version's baseModel (resolved from Postgres).
export type BaseModelPerformance = {
  baseModel: string;
  modelCount: number;
  generations: number;
  prevGenerations: number;
  downloads: number;
  prevDownloads: number;
  currencies: ModelCurrencyTotal[];
  buzzTotal: number;
  prevBuzzTotal: number;
};

async function fetchBaseModelPerformance({
  userId,
  from,
  to,
  compareFrom,
  compareTo,
}: {
  userId: number;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
}): Promise<BaseModelPerformance[]> {
  const uid = Number(userId);
  const versions = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('m.userId', '=', uid)
    .select(['mv.id as versionId', 'mv.baseModel as baseModel', 'mv.modelId as modelId'])
    .execute();
  if (!versions.length) return [];

  const prev = { from: compareFrom, to: compareTo };
  const idList = versions.map((v) => Number(v.versionId)).join(',');
  // Constrain modelId (daily_downloads' sort-key leader) so the unpartitioned table isn't full-scanned.
  const modelIdList = [...new Set(versions.map((v) => Number(v.modelId)))].join(',');
  const ch = getClickhouse();
  const [earnRows, genRows, dlRows] = await Promise.all([
    ch.$query<{
      modelVersionId: number | string;
      accountType: string;
      cur: number | string;
      prev: number | string;
    }>(
      `SELECT modelVersionId, accountType,
         sumIf(amount, date BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(amount, date BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.resourceCompensations
       WHERE userId = ${uid} AND date BETWEEN toDate('${prev.from}') AND toDate('${to}') AND ${CORRUPT_FILTER}
       GROUP BY modelVersionId, accountType`
    ),
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(count, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(count, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM orchestration.daily_resource_generation_counts
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<{ modelVersionId: number | string; cur: number | string; prev: number | string }>(
      `SELECT modelVersionId,
         sumIf(downloads, createdDate BETWEEN toDate('${from}') AND toDate('${to}')) AS cur,
         sumIf(downloads, createdDate BETWEEN toDate('${prev.from}') AND toDate('${prev.to}')) AS prev
       FROM default.daily_downloads
       WHERE modelId IN (${modelIdList}) AND modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${prev.from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
  ]);

  const genBy = new Map<number, { cur: number; prev: number }>();
  for (const r of genRows)
    genBy.set(Number(r.modelVersionId), { cur: Number(r.cur), prev: Number(r.prev) });
  const dlBy = new Map<number, { cur: number; prev: number }>();
  for (const r of dlRows)
    dlBy.set(Number(r.modelVersionId), { cur: Number(r.cur), prev: Number(r.prev) });
  const earnBy = new Map<number, { currency: string; cur: number; prev: number }[]>();
  for (const r of earnRows) {
    const vid = Number(r.modelVersionId);
    const arr = earnBy.get(vid) ?? [];
    arr.push({ currency: lowerFirst(r.accountType), cur: Number(r.cur), prev: Number(r.prev) });
    earnBy.set(vid, arr);
  }

  const byBase = new Map<string, BaseModelPerformance>();
  const modelsByBase = new Map<string, Set<number>>();
  const currByBase = new Map<string, Map<string, { total: number; prev: number }>>();
  for (const v of versions) {
    const baseModel = v.baseModel ?? 'Unknown';
    let e = byBase.get(baseModel);
    if (!e) {
      e = {
        baseModel,
        modelCount: 0,
        generations: 0,
        prevGenerations: 0,
        downloads: 0,
        prevDownloads: 0,
        currencies: [],
        buzzTotal: 0,
        prevBuzzTotal: 0,
      };
      byBase.set(baseModel, e);
      modelsByBase.set(baseModel, new Set());
      currByBase.set(baseModel, new Map());
    }
    modelsByBase.get(baseModel)!.add(Number(v.modelId));
    const vid = Number(v.versionId);
    const g = genBy.get(vid);
    if (g) {
      e.generations += g.cur;
      e.prevGenerations += g.prev;
    }
    const d = dlBy.get(vid);
    if (d) {
      e.downloads += d.cur;
      e.prevDownloads += d.prev;
    }
    const cm = currByBase.get(baseModel)!;
    for (const c of earnBy.get(vid) ?? []) {
      const acc = cm.get(c.currency) ?? { total: 0, prev: 0 };
      acc.total += c.cur;
      acc.prev += c.prev;
      cm.set(c.currency, acc);
      if (currencyMeta(c.currency).family === 'buzz') {
        e.buzzTotal += c.cur;
        e.prevBuzzTotal += c.prev;
      }
    }
  }
  for (const [baseModel, e] of byBase) {
    e.modelCount = modelsByBase.get(baseModel)!.size;
    e.currencies = [...currByBase.get(baseModel)!.entries()]
      .map(([currency, v]) => ({ currency, total: v.total, prev: v.prev }))
      .sort((a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order);
  }
  const active = [...byBase.values()].filter(
    (b) => b.generations > 0 || b.downloads > 0 || b.currencies.some((c) => c.total > 0)
  );
  active.sort(
    (a, b) =>
      b.generations - a.generations || b.downloads - a.downloads || b.buzzTotal - a.buzzTotal
  );
  return active;
}

export const getBaseModelPerformance = createCache({
  name: 'analytics:base-models',
  fetch: fetchBaseModelPerformance,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Per-version daily time series for one model (feedback 868ke493d) — the version-comparison overlay chart. Daily
// generations (`orchestration.daily_resource_generation_counts`) + downloads (`default.daily_downloads`) per version
// over the range, so the client can overlay any picked versions on either metric. Ownership is enforced from Postgres
// (returns null when the model isn't the caller's). Every version is returned — including zero-activity ones — so the
// picker can select them; `total*` drive the default top-N pick. Points are sparse (days with activity only); the
// client aligns them on the union of dates. `to` (<= today via parseRange) fences out the tables' future-dated junk.
export type VersionSeriesPoint = { date: string; generations: number; downloads: number };
export type VersionSeries = {
  versionId: number;
  versionName: string | null;
  baseModel: string | null;
  points: VersionSeriesPoint[];
  totalGenerations: number;
  totalDownloads: number;
};
export type ModelVersionSeries = {
  modelId: number;
  modelName: string | null;
  nsfw: boolean;
  nsfwLevel: number;
  versions: VersionSeries[];
};

async function fetchModelVersionSeries({
  userId,
  modelId,
  from,
  to,
}: {
  userId: number;
  modelId: number;
  from: string;
  to: string;
}): Promise<ModelVersionSeries | null> {
  const uid = Number(userId);
  const mid = Number(modelId);

  const model = await dbRead
    .selectFrom('Model')
    .where('id', '=', mid)
    .select(['id', 'name', 'userId', 'nsfw', 'nsfwLevel'])
    .executeTakeFirst();
  if (!model || Number(model.userId) !== uid) return null;

  const versions = await dbRead
    .selectFrom('ModelVersion')
    .where('modelId', '=', mid)
    .select(['id', 'name', 'baseModel'])
    .orderBy('createdAt', 'desc')
    .execute();

  const base: ModelVersionSeries = {
    modelId: mid,
    modelName: model.name ?? null,
    nsfw: !!model.nsfw,
    nsfwLevel: Number(model.nsfwLevel ?? 0),
    versions: versions.map((v) => ({
      versionId: Number(v.id),
      versionName: v.name ?? null,
      baseModel: v.baseModel ?? null,
      points: [],
      totalGenerations: 0,
      totalDownloads: 0,
    })),
  };
  if (!versions.length) return base;

  const idList = versions.map((v) => Number(v.id)).join(',');
  const ch = getClickhouse();
  const [genRows, dlRows] = await Promise.all([
    ch.$query<{ modelVersionId: number | string; date: string; count: number | string }>(
      `SELECT modelVersionId, toString(createdDate) AS date, sum(count) AS count
       FROM orchestration.daily_resource_generation_counts
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${from}') AND toDate('${to}')
       GROUP BY modelVersionId, date`
    ),
    ch.$query<{ modelVersionId: number | string; date: string; downloads: number | string }>(
      `SELECT modelVersionId, toString(createdDate) AS date, sum(downloads) AS downloads
       FROM default.daily_downloads
       WHERE modelId = ${mid} AND modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${from}') AND toDate('${to}')
       GROUP BY modelVersionId, date`
    ),
  ]);

  const byId = new Map(base.versions.map((v) => [v.versionId, v]));
  const pointsByVersion = new Map<number, Map<string, VersionSeriesPoint>>();
  const point = (vid: number, date: string) => {
    let byDate = pointsByVersion.get(vid);
    if (!byDate) pointsByVersion.set(vid, (byDate = new Map()));
    let p = byDate.get(date);
    if (!p) byDate.set(date, (p = { date, generations: 0, downloads: 0 }));
    return p;
  };
  for (const r of genRows) {
    const vid = Number(r.modelVersionId);
    if (byId.has(vid)) point(vid, String(r.date)).generations = Number(r.count);
  }
  for (const r of dlRows) {
    const vid = Number(r.modelVersionId);
    if (byId.has(vid)) point(vid, String(r.date)).downloads = Number(r.downloads);
  }
  for (const [vid, byDate] of pointsByVersion) {
    const v = byId.get(vid)!;
    v.points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    v.totalGenerations = v.points.reduce((s, p) => s + p.generations, 0);
    v.totalDownloads = v.points.reduce((s, p) => s + p.downloads, 0);
  }
  return base;
}

export const getModelVersionSeries = createCache({
  name: 'analytics:model-version-series',
  fetch: fetchModelVersionSeries,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;
