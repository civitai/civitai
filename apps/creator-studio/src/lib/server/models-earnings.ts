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

export type ModelCurrencyTotal = { currency: string; total: number };
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
export type ModelPerformance = ModelEarning & { generations: number; downloads: number };

// Cap on versions resolved + returned; bounds the Postgres enrichment and the table length.
const TOP_N = 100;

// The table is written by the external .NET orchestrator and carries known garbage rows (binary-junk accountType,
// absurd amounts up to ~2e267). A letters-only accountType + a sane amount bound keep those out of the sum.
const CORRUPT_FILTER = `match(accountType, '^[A-Za-z]+$') AND amount > 0 AND amount < 1e12`;

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

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

  // Fold (version × currency) rows into one entry per version; buzzTotal drives the ranking.
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
}: {
  userId: number;
  from: string;
  to: string;
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
  const idList = versions.map((v) => Number(v.versionId)).join(',');

  const ch = getClickhouse();
  const [earnRows, genRows, dlRows] = await Promise.all([
    ch.$query<{ modelVersionId: number | string; accountType: string; total: number | string }>(
      `SELECT modelVersionId, accountType, sum(amount) AS total
       FROM orchestration.resourceCompensations
       WHERE userId = ${uid} AND date >= toDate('${from}') AND date <= toDate('${to}') AND ${CORRUPT_FILTER}
       GROUP BY modelVersionId, accountType`
    ),
    ch.$query<{ modelVersionId: number | string; count: number | string }>(
      `SELECT modelVersionId, sum(count) AS count
       FROM orchestration.daily_resource_generation_counts
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
    ch.$query<{ modelVersionId: number | string; downloads: number | string }>(
      `SELECT modelVersionId, sum(downloads) AS downloads
       FROM default.daily_downloads
       WHERE modelVersionId IN (${idList}) AND createdDate BETWEEN toDate('${from}') AND toDate('${to}')
       GROUP BY modelVersionId`
    ),
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
      buzzTotal: 0,
      generations: 0,
      downloads: 0,
    });
  }
  for (const r of earnRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (!e) continue;
    const currency = lowerFirst(r.accountType);
    const total = Number(r.total);
    e.currencies.push({ currency, total });
    if (currencyMeta(currency).family === 'buzz') e.buzzTotal += total;
  }
  for (const r of genRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (e) e.generations = Number(r.count);
  }
  for (const r of dlRows) {
    const e = byId.get(Number(r.modelVersionId));
    if (e) e.downloads = Number(r.downloads);
  }

  const active = [...byId.values()].filter(
    (m) => m.currencies.length > 0 || m.generations > 0 || m.downloads > 0
  );
  // Rank by usage first (this is a performance view), then earnings — so a popular free model still surfaces.
  active.sort(
    (a, b) =>
      b.generations - a.generations || b.downloads - a.downloads || b.buzzTotal - a.buzzTotal
  );
  for (const m of active) {
    m.currencies.sort((a, b) => currencyMeta(a.currency).order - currencyMeta(b.currency).order);
  }
  return active.slice(0, TOP_N);
}

// Per-model performance (earnings + usage) for the /analytics table. Earnings are owner-keyed; usage is scoped by
// the creator's version ids (the usage tables have no owner column — Justin's recommendation).
export const getModelPerformance = createCache({
  name: 'models:performance',
  fetch: fetchModelPerformance,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;
