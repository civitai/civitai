// ClickHouse query strings whose correctness is worth pinning in a test. They live apart from
// `analytics.ts` only so a test can import them without its database and Redis imports; the other
// builders there have no test and stay put.

// Had this entity type started being tracked by the end of this period? The bound is `<= to` and
// nothing else: the question is monotone in time, so a `>= from` bound would answer false for a
// period where tracking was live and simply nobody viewed anything — which the surfaces render as
// "not collecting yet" rather than as the zero it is.
//
// Asking it all-time instead is the bug this replaced: the numbers it guards are period-scoped, so
// an all-time answer claims tracking was live for a month that predates the emitter, and the tab
// renders a confident row of zeros instead of its fallback.
export function viewTrackingSql(entityType: string, to: string): string {
  return `SELECT 1 AS one FROM daily_views WHERE entityType = '${entityType}' AND createdDate <= toDate('${to}') LIMIT 1`;
}

// A creator's daily image views. `image_views_daily_by_owner` is an owner-keyed rollup of
// `daily_views`, because the same answer off `daily_views` needs `entityId IN (this creator's
// images)` — a creator's ids are scattered across the whole id space, so the primary key prunes
// almost nothing and a 400-image creator reads 131M rows. Against the rollup it is an `ownerId`
// prefix seek: 3 marks.
//
// 🔴 The gap-fill stops at the rollup's own last sealed day, not at `to`. Its MV is
// `REFRESH EVERY 1 DAY OFFSET 2 HOUR` and appends yesterday only, so the most recent day or two are
// simply absent — and `WITH FILL` cannot tell absent from zero, so filling to `to` invents zeros and
// the chart dives at its right-hand edge. Reading the seal from the table rather than deriving it
// from the clock keeps this correct through a refresh-schedule change, and costs 8ms / 16k rows.
//
// Also note the rollup's join drops views on images with no `images_created` row (~0.4% in 2026,
// higher the further back you go).
export function ownerViewsDailySql(uid: number, from: string, to: string): string {
  const sealed = `assumeNotNull((SELECT max(createdDate) FROM image_views_daily_by_owner))`;
  return `SELECT createdDate AS date, sum(views) AS value FROM image_views_daily_by_owner WHERE ownerId = ${uid} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ORDER BY date WITH FILL FROM toDate('${from}') TO least(toDate('${to}'), ${sealed}) + 1 STEP 1`;
}
