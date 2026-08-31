import { getClickhouse } from '$lib/server/clickhouse';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';

// Civitai-wide base-model popularity over time (analytics feedback 4.6) — the platform trend a creator reads to
// decide what to build on next. Non-owner-scoped: every version's daily generations/downloads, rolled up to its
// base model via the `civitai_pg.ModelVersion` mirror (the daily tables carry only modelVersionId). Heavy but
// range-cached; the owner's own base-model table lives beside it on the tab.
export type PlatformBaseModelPoint = { date: string; generations: number; downloads: number };
export type PlatformBaseModelTrend = {
  baseModel: string;
  generations: number;
  downloads: number;
  points: PlatformBaseModelPoint[];
};

// Size of the selectable base-model universe (the toggle chips) for the primary month. The chart shows a smaller
// default subset; the creator toggles from here.
const TOP_N = 20;

// Names are delimited by newline when passed as the cache-key arg (base models never contain newlines).
const NAME_DELIM = '\n';
// Base-model names are a bounded, platform-controlled set, but escape quotes anyway so the interpolated IN list
// can't break the query.
const quoted = (name: string) => `'${name.replace(/'/g, "''")}'`;

async function fetchBaseModelTrends({
  from,
  to,
  only,
}: {
  from: string;
  to: string;
  // Newline-joined base-model names to restrict to (for the comparison month, so it covers the primary's set);
  // absent → the top platform base models.
  only?: string;
}): Promise<PlatformBaseModelTrend[]> {
  const names = only ? only.split(NAME_DELIM).filter(Boolean) : null;
  const filter =
    names && names.length ? `AND mv.baseModel IN (${names.map(quoted).join(',')})` : '';
  const ch = getClickhouse();
  const [genRows, dlRows] = await Promise.all([
    ch.$query<{ baseModel: string; date: string; generations: number | string }>(
      `SELECT mv.baseModel AS baseModel, toString(d.createdDate) AS date, sum(d.count) AS generations
       FROM orchestration.daily_resource_generation_counts AS d
       INNER JOIN civitai_pg.ModelVersion AS mv ON mv.id = d.modelVersionId
       WHERE d.createdDate BETWEEN toDate('${from}') AND toDate('${to}') ${filter}
       GROUP BY baseModel, date`
    ),
    ch.$query<{ baseModel: string; date: string; downloads: number | string }>(
      `SELECT mv.baseModel AS baseModel, toString(d.createdDate) AS date, sum(d.downloads) AS downloads
       FROM default.daily_downloads AS d
       INNER JOIN civitai_pg.ModelVersion AS mv ON mv.id = d.modelVersionId
       WHERE d.createdDate BETWEEN toDate('${from}') AND toDate('${to}') ${filter}
       GROUP BY baseModel, date`
    ),
  ]);

  const byBase = new Map<string, Map<string, PlatformBaseModelPoint>>();
  const point = (base: string, date: string) => {
    let dates = byBase.get(base);
    if (!dates) byBase.set(base, (dates = new Map()));
    let p = dates.get(date);
    if (!p) dates.set(date, (p = { date, generations: 0, downloads: 0 }));
    return p;
  };
  for (const r of genRows) {
    if (!r.baseModel) continue;
    point(r.baseModel, r.date).generations += Number(r.generations);
  }
  for (const r of dlRows) {
    if (!r.baseModel) continue;
    point(r.baseModel, r.date).downloads += Number(r.downloads);
  }

  const trends: PlatformBaseModelTrend[] = [...byBase.entries()].map(([baseModel, dates]) => {
    const points = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
      baseModel,
      generations: points.reduce((s, p) => s + p.generations, 0),
      downloads: points.reduce((s, p) => s + p.downloads, 0),
      points,
    };
  });
  trends.sort((a, b) => b.generations - a.generations);
  // A restricted (comparison) fetch already covers exactly the requested set — only the open primary fetch caps.
  return names ? trends : trends.slice(0, TOP_N);
}

export const getBaseModelTrends = createCache({
  name: 'analytics:base-model-trends',
  fetch: fetchBaseModelTrends,
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;
