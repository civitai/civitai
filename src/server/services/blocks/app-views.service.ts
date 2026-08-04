import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';

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
 *
 * NO TIME SERIES, on purpose. An earlier revision also ran a bucketed
 * `GROUP BY` query, which doubled the ClickHouse load per request for a value
 * NOTHING rendered — the panel charts only `installs.series` and `runs.series`.
 * That cost is paid on a fan-out path (see VIEWS_QUERY_TIMEOUT_SECONDS), so a
 * dead second round-trip is not free. If a views chart is ever added, restore
 * the query AND note that ClickHouse's `toStartOfWeek` defaults to SUNDAY while
 * Postgres `date_trunc('week', …)` is MONDAY — mode 1 is required, or the views
 * line sits a day out of phase with the runs line on the same axis.
 *
 * COVERAGE CAVEAT worth knowing before trusting the number: `blockRenders`
 * counts MOUNT ATTEMPTS, not successful loads. `/api/track/block-render` writes
 * a row even when the launch FAILS (it is a failed mount's only beacon) and the
 * table carries no status column, so this reader cannot exclude them. An app
 * that fails to load for everyone still reports loads.
 *
 * ⚠️ TRUST CAVEAT — this number is not adversary-proof, and reading it here is
 * what makes that matter. The writer, `/api/track/block-render`, is a
 * `PublicEndpoint` whose only gate is an Origin/Referer host comparison, which
 * any non-browser client can forge, and `appBlockId` arrives from the client.
 * So anyone can inflate an arbitrary author's load count. That is a pre-existing
 * WRITER-side weakness, deliberately not fixed in the change that added this
 * reader (it needs its own change to the ingest path) — but do not build
 * payouts, ranking, or anything else with an incentive to cheat on top of this
 * figure until the writer is authenticated.
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
  /**
   * Of `count`, how many IMPRESSIONS came from signed-out viewers — an
   * impression count, NOT a viewer count, and not a subset of `uniqueViewers`.
   * One anonymous visitor reloading ten times contributes 10 here and 1 to
   * `uniqueViewers`, so `anonCount` can exceed `uniqueViewers`. Label it as
   * loads wherever it is rendered next to a viewer figure.
   */
  anonCount: number;
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

/** A placeholder zero (we could not ask). Always carries the discriminator. */
export function unavailableViews(): AppViews {
  return { count: 0, uniqueViewers: 0, anonCount: 0, unavailable: true };
}

/** A measured zero (we asked, the answer was none). */
export function emptyViews(): AppViews {
  return { count: 0, uniqueViewers: 0, anonCount: 0 };
}

/**
 * ClickHouse DateTime parameter format (UTC, second resolution). The `time`
 * column is a `DateTime`, so sub-second precision is not representable anyway.
 */
function chDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Server-side execution cap, in seconds. The driver's own `request_timeout`
 * defaults to FIVE MINUTES (@clickhouse/client-common 0.2.10) and
 * `max_open_connections` to Infinity, neither of which this app overrides — so
 * without a bound a merely SLOW ClickHouse (not a down one) holds the whole
 * `Promise.all` in getMyAppAnalytics open for minutes.
 *
 * That matters more than it looks: `AppAnalyticsInline` issues one
 * `getMyAppAnalytics` PER APPROVED APP ROW in the submissions list, so a single
 * page load fans out to N of these. The degrade-don't-throw contract covered
 * errors only; latency needs its own bound, and the cap must be enforced
 * SERVER-side (`max_execution_time`) as well as client-side (`abort_signal`),
 * because aborting the socket alone leaves the query running on the cluster.
 */
export const VIEWS_QUERY_TIMEOUT_SECONDS = 10;

type RollupRow = {
  impressions: number | string;
  authedViewers: number | string;
  anonViewers: number | string;
  anonImpressions: number | string;
};

/**
 * VIEWS_WHERE is kept as ONE frozen string, and the tests pin it WHOLE.
 *
 * 🔴 This clause is the only thing that applies tenant isolation to the
 * impression read — ownership is resolved upstream, but this is where the
 * resolved ids actually constrain the scan. Asserting fragments of it with
 * substring matches is not enough: an adversarial sweep flipped `AND` to `OR`
 * (making the id filter a no-op, returning every author's impressions) and `IN`
 * to `NOT IN` (returning every OTHER author's impressions) and BOTH mutants
 * survived a fully green suite, because every fragment the tests looked for was
 * still present. So the test pins this exact normalised text. A cosmetic
 * reformat will fail that test; that is the intended trade.
 */
const VIEWS_WHERE = `WHERE appBlockId IN {appBlockIds:Array(String)} AND createdDate >= toDate({from:DateTime}) AND createdDate <= toDate({to:DateTime}) AND time >= {from:DateTime} AND time <= {to:DateTime}`;

/**
 * Impressions for `appBlockIds` between `from` and `to`.
 *
 * The caller MUST have already resolved `appBlockIds` to ids the requester
 * owns — this function applies no ownership check of its own, exactly like the
 * Postgres aggregates it sits beside.
 *
 * Never throws: a ClickHouse failure — including a TIMEOUT — degrades to
 * `unavailable: true` so one slow or flaky store cannot take down an analytics
 * panel whose other counters are fine.
 */
export async function getAppViews({
  appBlockIds,
  from,
  to,
  ch = clickhouse,
}: {
  appBlockIds: string[];
  from: Date;
  to: Date;
  ch?: typeof clickhouse;
}): Promise<AppViews> {
  // Defensive: the only production caller (getMyAppAnalytics) already returns
  // early when the owner has no apps, so this is not reachable from there. It
  // stays because the function is exported and a future caller must not be able
  // to turn an empty id list into an unfiltered scan.
  if (appBlockIds.length === 0) return emptyViews();

  // `clickhouse` is undefined whenever CLICKHOUSE_HOST/USERNAME are unset
  // (src/server/clickhouse/client.ts) — i.e. most dev and CI environments.
  if (!ch) return unavailableViews();

  try {
    // Bounds BOTH `time` (the real predicate) and `createdDate` (the partition
    // key) so the scan prunes partitions instead of reading the whole table.
    // `createdDate` is a `Date` (verified against prod: `system.columns` reports
    // `createdDate Date`, `time DateTime`), so comparing it to `toDate(...)` is
    // the correct granularity — if it were ever migrated to `DateTime` the
    // upper bound would silently truncate to midnight and drop the current
    // day's impressions with no error and no `unavailable` flag.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIEWS_QUERY_TIMEOUT_SECONDS * 1000);
    try {
      const rollupResp = await ch.query({
        query: `
          SELECT
            count() AS impressions,
            uniqExactIf(userId, isAnon = 0) AS authedViewers,
            uniqExactIf(ip, isAnon = 1) AS anonViewers,
            countIf(isAnon = 1) AS anonImpressions
          FROM blockRenders
          ${VIEWS_WHERE}
        `,
        query_params: {
          appBlockIds,
          from: chDateTime(from),
          to: chDateTime(to),
        },
        format: 'JSONEachRow',
        abort_signal: controller.signal,
        clickhouse_settings: { max_execution_time: VIEWS_QUERY_TIMEOUT_SECONDS },
      });

      const [rollup] = (await rollupResp.json()) as RollupRow[];

      return {
        count: Number(rollup?.impressions ?? 0),
        // Authenticated viewers are distinct userIds; signed-out viewers all
        // share userId 0, so they are counted by distinct ip and added on.
        uniqueViewers: Number(rollup?.authedViewers ?? 0) + Number(rollup?.anonViewers ?? 0),
        anonCount: Number(rollup?.anonImpressions ?? 0),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // Degrade, don't throw: the rest of the payload is still good data. This
    // also catches the abort, so a timeout reads as `unavailable` rather than
    // as zero impressions.
    logToAxiom(
      {
        name: 'app-views-service',
        type: 'error',
        message: 'blockRenders read failed',
        error: (error as Error)?.message,
      },
      // Same datastream as every other ClickHouse failure site (tracker.ts), so
      // this lands next to its siblings rather than in a stream of its own.
      'clickhouse'
    ).catch(() => undefined);
    return unavailableViews();
  }
}
