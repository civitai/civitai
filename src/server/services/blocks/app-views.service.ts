import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import type { AnalyticsTimePoint } from './app-analytics.service';

/**
 * App Blocks — author-facing IMPRESSIONS, read from the `blockRenders`
 * ClickHouse table.
 *
 * WHY THIS EXISTS: every other author metric comes from Postgres, and the
 * engagement counters specifically come from `block_scope_invocations`, which
 * is written ONLY on authenticated, scope-gated API calls. Anonymous viewers
 * and static / no-scope blocks emit nothing there, so a block with no scoped
 * API surface reports flat engagement no matter how many people saw it.
 * `blockRenders` is the only signal that covers them — it is written once per
 * host mount (BLOCK_READY) by two writers (the `/api/track/block-render` REST
 * beacon and the `track.blockRender` tRPC proc), both via `tracker.blockRender`.
 *
 * 🔴 UNIQUE VIEWERS DO NOT DEDUP ON `blockInstanceId`. That id looks per-mount
 * and is not: it is `page_apb_<ULID>`, effectively one per PLACEMENT. Measured
 * against prod on 2026-08-04 — 124 rows carried only 28 distinct
 * `blockInstanceId` across 27 distinct `appBlockId`, i.e. ~1:1 with the app —
 * so deduping on it would report "1 unique viewer" for an app with hundreds of
 * impressions. The viewer identity is `userId`, and for signed-out rows
 * (`isAnon`) `userId` is a literal 0 for EVERYONE, so anon rows must dedup on
 * `ip` instead or they collapse into a single phantom viewer. Hence the
 * `uniqExactIf(userId, …) + uniqExactIf(ip, …)` split below.
 *
 * 🔴 NEVER interpolate into these queries. The `$query` tagged template on the
 * ClickHouse client formats strings VERBATIM (`formatSqlType` returns the raw
 * value — no quoting, no escaping), so `${id}` is a SQL-injection vector. Every
 * value here rides in `query_params` instead, which the driver binds; that also
 * matches the repo's other parameterised reads (scanner-review.service.ts).
 */

/** Impressions for a set of owned app blocks over a bounded range. */
export type AppViews = {
  /** Total impressions (one row per host mount) within the range. */
  count: number;
  /**
   * Distinct viewers: authenticated viewers by `userId`, plus signed-out
   * viewers by `ip`. See the dedup note above for why neither key alone works.
   * IP-based counting is an approximation (shared NAT under-counts, mobile
   * roaming over-counts) — it is a reach indicator, not an identity count.
   */
  uniqueViewers: number;
  /** Of `count`, how many impressions came from signed-out viewers. */
  anonCount: number;
  /** Impressions per bucket within the range. */
  series: AnalyticsTimePoint[];
  /**
   * TRUE when the impression store could not be read — ClickHouse is not
   * configured for this deployment, or the query failed. The zeros above are
   * then a PLACEHOLDER, NOT a measurement.
   *
   * This is deliberately a PER-SECTION flag rather than a third value on the
   * payload-level `AppAnalytics['unavailable']`: ClickHouse being down says
   * nothing about the Postgres-derived installs/runs/revenue counters in the
   * same response, which are still genuinely measured. Flagging the whole
   * payload would throw away good data; omitting the flag entirely would
   * reproduce the fabricated-zero defect that civitai#3557 and civitai#3581
   * fixed, where a renderer cannot tell "nobody looked" from "we never asked".
   */
  unavailable?: boolean;
};

/** A genuinely-measured zero (we asked, the answer was none). */
export const EMPTY_VIEWS: AppViews = Object.freeze({
  count: 0,
  uniqueViewers: 0,
  anonCount: 0,
  series: [],
});

/** A placeholder zero (we could not ask). Always carries the discriminator. */
export function unavailableViews(): AppViews {
  return { count: 0, uniqueViewers: 0, anonCount: 0, series: [], unavailable: true };
}

/** A measured zero, as a fresh mutable object. */
export function emptyViews(): AppViews {
  return { count: 0, uniqueViewers: 0, anonCount: 0, series: [] };
}

/**
 * ClickHouse DateTime parameter format (UTC, second resolution). The column is
 * a `DateTime`, so sub-second precision is not representable anyway.
 */
function chDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

type RollupRow = {
  impressions: number | string;
  authedViewers: number | string;
  anonViewers: number | string;
  anonImpressions: number | string;
};

type SeriesRow = { bucketTs: number | string; value: number | string };

/**
 * Impressions for `appBlockIds` between `from` and `to`.
 *
 * The caller MUST have already resolved `appBlockIds` to ids the requester
 * owns — this function applies no ownership check of its own, exactly like the
 * Postgres aggregates it sits beside.
 *
 * Never throws: a ClickHouse failure degrades to `unavailable: true` so one
 * flaky store cannot take down an analytics panel whose other counters are
 * fine.
 */
export async function getAppViews({
  appBlockIds,
  from,
  to,
  granularity,
  ch = clickhouse,
}: {
  appBlockIds: string[];
  from: Date;
  to: Date;
  granularity: 'day' | 'week';
  ch?: typeof clickhouse;
}): Promise<AppViews> {
  // No owned ids → nothing to ask about. This is a measured zero, not an
  // outage, so it must NOT carry the unavailable flag.
  if (appBlockIds.length === 0) return emptyViews();

  // `clickhouse` is undefined whenever CLICKHOUSE_HOST/USERNAME are unset
  // (src/server/clickhouse/client.ts) — i.e. most dev and CI environments.
  if (!ch) return unavailableViews();

  // Week buckets must start MONDAY to line up with the Postgres series, which
  // uses date_trunc('week', …) — ClickHouse's toStartOfWeek defaults to mode 0
  // (Sunday), so mode 1 is load-bearing, not decoration. A mismatch would draw
  // the views line one day out of phase with the runs line on the same chart.
  const bucketExpr = granularity === 'week' ? 'toStartOfWeek(time, 1)' : 'toStartOfDay(time)';

  // Bound BOTH `time` (the real predicate) and `createdDate` (the partition
  // key) so the scan prunes partitions instead of reading the whole table.
  const where = `
    WHERE appBlockId IN {appBlockIds:Array(String)}
      AND createdDate >= toDate({from:DateTime})
      AND createdDate <= toDate({to:DateTime})
      AND time >= {from:DateTime}
      AND time <= {to:DateTime}
  `;

  const query_params = {
    appBlockIds,
    from: chDateTime(from),
    to: chDateTime(to),
  };

  try {
    const [rollupResp, seriesResp] = await Promise.all([
      ch.query({
        query: `
          SELECT
            count() AS impressions,
            uniqExactIf(userId, isAnon = 0) AS authedViewers,
            uniqExactIf(ip, isAnon = 1) AS anonViewers,
            countIf(isAnon = 1) AS anonImpressions
          FROM blockRenders
          ${where}
        `,
        query_params,
        format: 'JSONEachRow',
      }),
      ch.query({
        query: `
          SELECT toUnixTimestamp(${bucketExpr}) AS bucketTs, count() AS value
          FROM blockRenders
          ${where}
          GROUP BY bucketTs
          ORDER BY bucketTs ASC
        `,
        query_params,
        format: 'JSONEachRow',
      }),
    ]);

    const [rollup] = (await rollupResp.json()) as RollupRow[];
    const seriesRows = (await seriesResp.json()) as SeriesRow[];

    return {
      count: Number(rollup?.impressions ?? 0),
      // Authenticated viewers are distinct userIds; signed-out viewers all
      // share userId 0, so they are counted by distinct ip and added on.
      uniqueViewers: Number(rollup?.authedViewers ?? 0) + Number(rollup?.anonViewers ?? 0),
      anonCount: Number(rollup?.anonImpressions ?? 0),
      series: seriesRows.map((r) => ({
        bucket: new Date(Number(r.bucketTs) * 1000).toISOString(),
        value: Number(r.value),
      })),
    };
  } catch (error) {
    // Degrade, don't throw: the rest of the payload is still good data.
    logToAxiom({
      name: 'app-views-service',
      type: 'error',
      message: 'blockRenders read failed',
      error: (error as Error)?.message,
    }).catch(() => undefined);
    return unavailableViews();
  }
}
