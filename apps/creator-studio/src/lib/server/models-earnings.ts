import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { currencyMeta } from '$lib/earnings';

// Per-model earnings — A1 **Part 2**. Reads `orchestration.resourceCompensations`, where the orchestrator now
// stamps the owner `userId` onto every row (backfilled to 2024-08), so "this creator's models" is a cheap `userId`
// filter — no `modelVersionId → owner` dictionary. The table is a `SharedSummingMergeTree`, so always
// `sum(amount)` + `GROUP BY` at read time. `amount` is fractional Float64; `accountType` is Capitalized
// (`Yellow`/`Blue`/`Green`/`CashSettled`) unlike `buzzTransactions`, so we lower-first it onto the shared currency
// vocabulary. Currencies are never converted or merged across families (B8). Rationale + schema:
// docs/creator-studio/licensing-fee-owner-stamping.md (in the main app).

export const MODEL_EARNINGS_RANGES = [7, 30, 90] as const;
export type ModelEarningsRange = (typeof MODEL_EARNINGS_RANGES)[number];

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

// Cap on versions resolved + returned; bounds the Postgres enrichment and the table length.
const TOP_N = 100;

const rangeTtlSeconds = (days: number) => (days >= 90 ? 3600 : days >= 30 ? 900 : 300);

// The table is written by the external .NET orchestrator and carries known garbage rows (binary-junk accountType,
// absurd amounts up to ~2e267). A letters-only accountType + a sane amount bound keep those out of the sum.
const CORRUPT_FILTER = `match(accountType, '^[A-Za-z]+$') AND amount > 0 AND amount < 1e12`;

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

async function fetchModelEarnings({
  userId,
  days,
}: {
  userId: number;
  days: number;
}): Promise<ModelEarning[]> {
  const uid = Number(userId);
  const d = Number(days);

  const rows = await getClickhouse().$query<{
    modelVersionId: number | string;
    accountType: string;
    total: number | string;
  }>(
    `SELECT modelVersionId, accountType, sum(amount) AS total
     FROM orchestration.resourceCompensations
     WHERE userId = ${uid} AND date >= today() - ${d} AND ${CORRUPT_FILTER}
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
  ttlSeconds: ({ days }) => rangeTtlSeconds(days),
}).get;
