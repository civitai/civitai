import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * WINDOWED COLLECTION POPULARITY, FROM CLICKHOUSE.
 *
 * Produces a RANKED LIST OF COLLECTION IDS for a time window — "most followed this
 * day / week / month / year" — for the App Blocks discovery grid. It answers with
 * ids and nothing else: every id it returns is still hydrated and filtered through
 * the caller's own Postgres predicates before anything is shown.
 *
 * 🔴 THIS IS A RANKING SOURCE, NOT AN AUTHORIZATION SOURCE. ClickHouse holds no
 * notion of a collection's privacy, its type, its maturity or whether it still
 * exists. An id coming back from here is a CANDIDATE. The caller
 * (`src/pages/api/v1/blocks/collections/index.ts`) re-reads every id through
 * `getAllCollections` with `privacy: [Public]` + `types: [Image]`, so a private or
 * non-Image collection that ranks first here simply does not come back from the
 * hydrate and is walked past. Never render an id from this module directly.
 *
 * 🔴 ALL-TIME IS DELIBERATELY NOT SERVED HERE, AND THAT IS NOT AN OVERSIGHT.
 * `entityMetricDailyAgg_history_v2` begins 2025-11-06 (measured 2026-09-11: 280
 * distinct days for `followerCount`). Summing the whole table would produce a
 * number that LOOKS like an all-time total and is actually "since November", with
 * nothing in the response to say so. All-time keeps the caller's existing Postgres
 * ordering, unchanged. {@link isWindowedPeriod} is the one predicate that splits
 * the two, so the rule cannot be re-derived differently at a second call site.
 *
 * 🔴 `total` IS A PER-DAY DELTA, NOT A CUMULATIVE SNAPSHOT. Sampled on one
 * collection it reads 15, 24, 18, 22, 25, 32 on successive days. So a window is
 * `SUM(total) … GROUP BY entityId`, never "read the latest row".
 *
 * 🔴 READ THE `_history_` TABLE. `entityMetricDailyAgg_v2` holds only the CURRENT
 * day (`first_day == last_day`), which reads exactly like "there is no history
 * here" and sends the reader off to build a Postgres job instead.
 */

/**
 * Days of history summed for each windowed period.
 *
 * 🔴 THE BOUND IS INCLUSIVE ON BOTH ENDS — `day >= today() - N` — so the window
 * spans N+1 calendar days, not N. That extra day is deliberate slack for the
 * DAILY SEAL'S LAG: the aggregate for the current day is written late, so an
 * exclusive `day > today() - 1` window for `Day` resolves to "today only" and
 * comes back EMPTY for most of the day. A tolerant lower bound costs one day of
 * over-inclusion on a ranking; an intolerant one costs the whole feature.
 */
export const PERIOD_WINDOW_DAYS = {
  [MetricTimeframe.Day]: 1,
  [MetricTimeframe.Week]: 7,
  [MetricTimeframe.Month]: 30,
  [MetricTimeframe.Year]: 365,
} as const;

export type WindowedPeriod = keyof typeof PERIOD_WINDOW_DAYS;

/**
 * How deep the windowed leaderboard goes. Pagination on this path is an OFFSET
 * into this bounded list (see the caller's cursor comment), so this constant is
 * also the hard end of the windowed feed.
 *
 * 🔴 TEN THOUSAND, NOT A THOUSAND, AND THE REASON IS NOT "more is better" — IT IS
 * THAT NINE IN TEN RANKED IDS ARE NOT SHOWABLE. Measured on the production replica
 * 2026-09-11 over the Month window's top 1,000 ids: every one of them is `Public`
 * (privacy rejects ZERO here), but only **81** are `CollectionType.Image`. The
 * other 919 are Model (914), Post (4) and Article (1) collections, which this
 * endpoint has always excluded because they render an empty player. So the
 * leaderboard's usable yield is ~4.5%, and a 1,000-deep list is a feed of ~81
 * collections — three and a bit pages.
 *
 * Cumulative Image+Public survivors by depth, same window and measurement:
 *
 *     depth      97   385  1000  2500  5000  10000
 *     survivors  21    42    81   337   396    446
 *
 * 🔴 AND DEPTH IS VERY NEARLY FREE, WHICH IS WHAT MAKES THIS THE RIGHT LEVER. The
 * `GROUP BY entityId` scans the window regardless; `LIMIT` only trims the sorted
 * output. Measured server-side elapsed, depth 1,000 vs 10,000: Day 15.1 → 12.3 ms,
 * Month 102.7 → 33.5 ms, Year 143.0 → 138.2 ms. Ten times the feed for no
 * measurable query cost. (Day tops out at 2,770 collections with any follower gain
 * at all, so it is bounded by the data rather than by this number.)
 */
export const CH_RANKING_DEPTH = 10_000;

/**
 * Is this period one ClickHouse can serve?
 *
 * `AllTime` and an absent period are BOTH false — the caller must take its
 * existing Postgres path for either. Keeping this as one exported predicate is
 * what stops "windowed" being spelled a second, subtly different way at another
 * call site.
 */
export function isWindowedPeriod(period: MetricTimeframe | undefined): period is WindowedPeriod {
  return period !== undefined && period !== MetricTimeframe.AllTime;
}

/**
 * The inclusive lower bound of the window, as a `YYYY-MM-DD` UTC date literal.
 *
 * Exported so a test can pin the exact literal each period produces against a
 * frozen clock, rather than asserting that "a date" appeared in the SQL.
 */
export function windowStartDate(period: WindowedPeriod, now: Date = new Date()): string {
  const start = new Date(now.getTime() - PERIOD_WINDOW_DAYS[period] * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}

export type WindowedRankingResult =
  | { ids: number[]; source: 'clickhouse' }
  /**
   * ClickHouse could not answer. `reason` is carried all the way to the response
   * body by the caller — an unavailable analytics store must degrade to a
   * DIFFERENT, STATED ordering, never to a mysteriously empty grid.
   */
  | { ids: null; source: 'unavailable'; reason: 'clickhouse-disabled' | 'clickhouse-error' };

/**
 * Rank collection ids by followers gained inside `period`'s window.
 *
 * Returns at most {@link CH_RANKING_DEPTH} ids, most-followed first. Ties break on
 * `entityId DESC` so the ordering is TOTAL and therefore STABLE across the
 * offset-paginated requests that walk it — without that tiebreak two pages of the
 * same feed can disagree about where a tied block of ids sits and silently drop or
 * repeat one.
 *
 * 🔴 `clickhouse.$query` INTERPOLATES, IT DOES NOT BIND. Nothing user-supplied
 * reaches this SQL: `period` is a key into {@link PERIOD_WINDOW_DAYS} (it selects a
 * number, it is never printed), the date is produced by {@link windowStartDate}
 * from a `Date`, and the depth is a module constant. Keep it that way — if this
 * ever needs a caller-supplied value, quote it, do not template it.
 */
export async function getWindowedCollectionRanking({
  period,
  now,
  depth = CH_RANKING_DEPTH,
}: {
  period: WindowedPeriod;
  now?: Date;
  depth?: number;
}): Promise<WindowedRankingResult> {
  // The client is `undefined` whenever `shouldConnect` is false (no CLICKHOUSE_HOST
  // / username, or a Next build). That is a normal deployment state, not a fault —
  // report it and let the caller fall back to its Postgres ordering.
  if (!clickhouse) return { ids: null, source: 'unavailable', reason: 'clickhouse-disabled' };

  const since = windowStartDate(period, now);
  const query = `
    SELECT entityId AS id
    FROM entityMetricDailyAgg_history_v2
    WHERE entityType = 'Collection'
      AND metricType = 'followerCount'
      AND day >= toDate('${since}')
    GROUP BY entityId
    HAVING sum(total) > 0
    ORDER BY sum(total) DESC, entityId DESC
    LIMIT ${Math.trunc(depth)}
  `;

  try {
    const rows = await clickhouse.$query<{ id: number }>(query);
    return { ids: rows.map((r) => Number(r.id)), source: 'clickhouse' };
  } catch (error) {
    // Swallowed on purpose: discovery must keep serving. The caller degrades to
    // its Postgres ordering and SAYS SO in the response, so the degradation is
    // observable from the outside rather than only in this log line.
    logToAxiom({
      name: 'block-collection-ranking-degraded',
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      period,
      since,
    }).catch(() => null);
    return { ids: null, source: 'unavailable', reason: 'clickhouse-error' };
  }
}
