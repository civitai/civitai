import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import type { AppOpenCountRow, AppOpenRecentRow } from '~/server/metrics/appListing.metrics.sql';
import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_BATCH_SIZE,
  APP_LISTING_METRIC_UPSERT_SQL,
  APP_OPEN_CH_CHUNK_SIZE,
  fetchAppOpenCounts,
  fetchRecentlyOpenedBlockIds,
} from '~/server/metrics/appListing.metrics.sql';
import { recordAppListingOpenDiscoveryDegrade } from '~/server/metrics/appListing.metrics.prom';
import { logToAxiom } from '~/server/logging/client';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:appListing');
/**
 * POSTGRES upsert batch size. NOT the ClickHouse chunk size — see the
 * two-directional-pressure note on both constants in appListing.metrics.sql.ts.
 * They were one constant until it was measured that sharing them costs 9.75x on the
 * ClickHouse side at seed scale — 39 scans against the 4 that splitting them gives.
 * (39x is a DIFFERENT comparison: 39 scans against the one unchunked query that
 * preceded chunking at all. The two are censused at the constants' own docstrings.)
 */
const BATCH_SIZE = APP_LISTING_BATCH_SIZE;

/** One affected listing plus the join key both counters need. */
type AffectedListing = { id: string; appBlockId: string | null };

// ---------------------------------------------------------------------------
// App Store Listings (W13) — AllTime-only rollup for AppListingMetric.
//
// AppListingMetric is a SINGLE row per listing keyed by `app_listing_id` (no
// `timeframe` column, like Model3DMetric). This processor owns the two counters
// the read path actually consumes:
//
//   • installCount  — on-site listings: count of ACTIVE BlockUserSubscription
//     rows for the listing's app_block_id. "Active" = `enabled = true`, matching
//     how app-analytics.service.ts defines the live install base (total vs
//     enabled) + the marketplace `_count userSubscriptions`. BlockUserSubscription
//     has NO soft-delete/`deletedAt` column; a toggle-off flips `enabled=false`
//     (which bumps `updated_at` via @updatedAt, so the incremental affected-query
//     catches it). A hard uninstall (row DELETE) is NOT catchable incrementally —
//     see the SQL note in appListing.metrics.sql. This drives the store `popular`
//     sort (`install_count DESC`) and the top-rated Bayesian tiebreak.
//
//   • openCount     — on-site listings: PLAYS, derived from the ClickHouse
//     `App_Open` event stream that the `/apps/run/<slug>` SSR resolver emits per
//     launch (`app-listing-open.service.ts`). See below.
//
// 🔴 OWNERSHIP CONTRACT: `thumbs_up_count` / `thumbs_down_count` are owned by the
// SYNCHRONOUS writer in app-listing-review.service.ts (upsert tx). This job MUST
// NEVER write those two columns — the ON CONFLICT DO UPDATE names ONLY
// install_count / open_count / updated_at, so a metric row that already exists
// (created by the thumbs writer) keeps its thumbs untouched. On CREATE, thumbs
// default to 0 (schema default), correct for a never-reviewed listing.
//
// 🔴 `open_count` IS DERIVED, NEVER INCREMENTED — that is the whole reason this
// arc uses an event stream. The contract in app-listing-review.service.ts reads:
// "'No recompute' is a TWO-SIDED contract … A third writer is only safe if it
// brings a full recompute with it." This is that third writer, and the recompute
// it brings is total: every run recomputes each affected listing's play count from
// ALL of its `App_Open` rows. There is no `+1` path anywhere and there must never
// be one — a delta counter over a stream nobody can replay is exactly the drift
// the thumbs pair is grandfathered into and nothing new should join.
//
// 🔴 THE RAW ROW COUNT IS NOT THE NUMBER — DEDUP HAPPENS AT READ TIME. The emit is
// triggered by an unauthenticated GET on an optional catch-all route with no rate
// limit and no robots disallow, so a refresh loop, a crawler or a chat-client link
// unfurler each manufacture rows. The rollup therefore counts ONE PLAY PER
// DISTINCT ACTOR PER APP PER UTC DAY (actor = `userId` when non-zero, else `ip`)
// and sums those daily distinct counts over all time. The full plain-English
// semantics — including why the figure is deliberately a LOWER bound — live on
// `buildAppOpenCountSql` in appListing.metrics.sql.ts, next to the SQL that
// implements them. Stage 4 prints this next to the review count on a public card;
// the label has to match what it counts.
//
// 🔴 OFF-SITE LISTINGS ARE STRUCTURALLY UNMEASURABLE, NOT AT ZERO. Their CTA is a
// third-party anchor, so no on-platform request follows the click. Both counters
// gate on `app_block_id`, which is NULL for off-site, so this falls out of the
// join — but a `0` in `open_count` therefore means "no plays OR not measurable",
// and the two are not distinguishable in the column. Stage 3 must project
// `openCount` as `null` for `kind='offsite'` rather than 0: the operator's
// decision is that off-site cards OMIT the stat rather than show a zero that reads
// as "nobody used it". Do not close the gap with a client beacon either — that
// would put a spoofable count beside a trusted one under one label.
//
// 🔴 RECOMPUTABILITY HAS ONE HOLE, AND IT NOW FAILS TO ZERO RATHER THAN FREEZING.
// The recompute joins `details.appBlockId` to `AppListing.appBlockId`, and that
// relation is `onDelete: SetNull` — deleting an AppBlock nulls the listing's
// `app_block_id` and every historical play row for it becomes permanently
// unjoinable. That much is unchanged. What WAS worse: such a listing matched no arm
// of the affected query, so a published `open_count = 777` was frozen at 777
// forever with no path to correct it. The affected query's REPAIR ARM now selects
// it so the recompute writes 0 — "we cannot measure this any more" instead of a
// stale public number. Recovering the real count still needs the listing id carried
// in `details`; do that if deletions become a real case.
//
// 🔴 BUT THE ARM'S PREDICATE IS NOT "an AppBlock was deleted" — it is "NULL join
// key AND a non-zero published count", and `app_block_id IS NULL` is NOT a kind
// discriminator (the schema says so on `AppListing.appBlockId`: "discriminate on
// `kind`, never on appBlockId nullness"). It therefore also matches a
// NATIVELY-CREATED OFF-SITE listing, which never had an AppBlock to lose. That
// population is expected to be empty — off-site rows are written 0 by this very
// upsert — so the arm is a no-op over it and there is no behavioural defect; a row
// that DID appear there would be wrong by definition and wants the same clearing.
// The consequence is for FOLLOW-UPS: an alert reading "repair arm fired ⇒ an
// AppBlock was deleted" would misfire on ordinary off-site rows. Full statement of
// both populations is on `AFFECTED_APPROVED_LISTINGS_SQL`.
//
// 🔴 `open_count` HAS NO READER AT THIS REF — its consumer lands in STAGE 3. The
// rule below ("populate with the PR that ships its consumer") is real and this
// column is a deliberate, argued exception to it, not an oversight and not a
// precedent. The argument in full — trusted server-side source + a derived,
// idempotent value with no accumulating state and no backfill — is on the SCOPE
// block in appListing.metrics.sql.ts. Read it before citing this file to populate
// anything else.
//
// NOT POPULATED (left at their schema default 0 — no reader today, and each maps
// to a feature that isn't live): `connect_count` (off-site OAuth-connect grants —
// OAuth-connect submission is a locked-deferred product decision, so there are no
// connect listings yet and nothing reads the count), `visit_count`, `tipped_count`,
// `tipped_amount_count` (visit is never recorded server-side; AppListing is not a
// BuzzTip entity — BuzzTip.entityId is Int, AppListing.id is a string ULID).
// Populate each with the PR that ships its consumer, not speculatively. None of the
// four has a source to derive from, so the `open_count` exception does not reach
// them: populating one would mean inventing the number.
//
// 🔴 MERGE NOTE (#4652 -> #4653, resolved deliberately, NOT by keeping both sides).
// #4652 landed a block here headed "`open_count` IS THE NEXT ONE, AND ITS SOURCE ROWS
// NOW EXIST", listing two obligations for "whoever writes that rollup": dedupe at read
// time, and add `open_count` to the ON CONFLICT list. THIS PR IS THAT ROLLUP and
// discharges both — the dedup rule is stated above and implemented in
// `buildAppOpenCountSql`; the ON CONFLICT list now names `open_count`. That block was
// therefore dropped rather than merged: kept, it would tell the next reader the rollup
// is unwritten and that `open_count` is unpopulated, in the file whose SQL populates it.
// #4652 also removed `open_count` from the not-populated list's parenthetical for the
// same reason; that removal is preserved above.
// ---------------------------------------------------------------------------

export const appListingMetrics = createMetricProcessor({
  name: 'AppListing',
  async update(ctx) {
    // 1. Ask ClickHouse which app blocks were PLAYED since the watermark. Nothing
    //    in Postgres moves when a play happens, so without this a listing whose
    //    only change is new plays would never be recomputed. (ClickHouse-first
    //    affected discovery — same shape as model3d.metrics.ts getDownloadTasks.)
    //    FAILS SOFT — see the asymmetry note on getRecentlyOpenedBlockIds.
    const recentlyOpened = await getRecentlyOpenedBlockIds(ctx);

    // 2. Collect affected approved listing ids (string ULIDs — the shared
    //    number-typed getAffected helper can't be reused, so this is inline).
    const affected = await getAffectedListings(ctx, recentlyOpened);
    log('appListingMetrics update', affected.length, 'affected listings');
    if (!affected.length) return;

    // 3. FULL play recompute for the WHOLE affected set — not just the blocks
    //    from step 1. `open_count` is derived, so a listing recomputed for an
    //    unrelated reason (a new subscription, a seed row) is written from this
    //    map too; a block missing from it is written as 0. Feeding only the
    //    recently-active blocks here would zero every other listing's play count.
    //    FAILS HARD, deliberately — see the asymmetry note on this function.
    const openCounts = await getAllTimeOpenCounts(ctx, affected);

    // 4. Batched live-recompute + upsert (install/open only; thumbs untouched).
    const tasks: Task[] = chunk(affected, BATCH_SIZE).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('appListing upsert batch', i + 1, 'of', tasks.length);
      const ids = batch.map((l) => l.id);
      // Parallel arrays for the upsert's `unnest($2, $3)` join, keyed through a Map
      // so the (app_block_id, open_count) pairs are unique.
      //
      // DEFENSIVE, NOT LOAD-BEARING — do not read this as the thing preventing
      // "ON CONFLICT DO UPDATE cannot affect row a second time". That error is real
      // and a widened join is how you'd reach it, but `AppListing.appBlockId` is
      // `@unique`, so two listings in one batch cannot share an app_block_id and no
      // batch can contain a duplicate to begin with. The Map costs nothing and
      // keeps the invariant local instead of borrowed from a schema constraint
      // three files away.
      const batchCounts = new Map<string, number>();
      for (const listing of batch) {
        if (!listing.appBlockId) continue;
        batchCounts.set(listing.appBlockId, openCounts.get(listing.appBlockId) ?? 0);
      }
      const blockIds = [...batchCounts.keys()];
      const counts = blockIds.map((id) => batchCounts.get(id) ?? 0);

      const query = await ctx.pg.cancellableQuery(APP_LISTING_METRIC_UPSERT_SQL, [
        ids,
        blockIds,
        counts,
      ]);
      ctx.jobContext.on('cancel', query.cancel);
      await query.result();
      log('appListing upsert batch', i + 1, 'done');
    });
    await limitConcurrency(tasks, 5);
  },
  // No AppListingRank table exists — the `popular` store sort reads
  // AppListingMetric directly. Only `update` is implemented (no refreshRank).
});

/**
 * Run a ClickHouse query with this job's cancellation wired in.
 *
 * `ctx.ch.$query` exposes no abort handle, so these reads used to outlive a
 * cancelled job while the Postgres queries beside them (which DO get a
 * `jobContext.on('cancel', query.cancel)`) were torn down. Dropping to
 * `ctx.ch.query` is what makes `abort_signal` reachable.
 *
 * 🔴 WHAT THIS ACTUALLY BUYS, STATED NARROWLY — IT IS A CLIENT-SIDE TEARDOWN, NOT A
 * SERVER-SIDE KILL. `AbortController.abort()` ends the Node-side HTTP request: the
 * `@clickhouse/client` promise rejects, the response stream stops being consumed
 * and the socket is released, so a cancelled job stops holding a connection and
 * stops buffering rows. It does NOT cancel the query inside ClickHouse. A
 * server-side abort on client disconnect requires
 * `cancel_http_readonly_queries_on_client_close`, which defaults to 0 and which
 * `createClickhouseClient` does not set — its `clickhouse_settings` are
 * `async_insert`, `wait_for_async_insert` and
 * `output_format_json_quote_64bit_integers` only
 * (packages/civitai-clickhouse/src/client.ts).
 *
 * 🔴 SO SIZE CLICKHOUSE FOR THE SCAN RUNNING TO COMPLETION. That matters
 * concretely for the count read, which is a full `actions` scan issued once per
 * `APP_OPEN_CH_CHUNK_SIZE` chunk: on the seed path those in-flight scans finish
 * server-side whether or not the job that asked for them still exists. To make the
 * stronger claim true, set that setting (per-query or on the client) — do not
 * assume it from the presence of `abort_signal`.
 */
async function chCancellableQuery<T extends object>(
  ctx: MetricProcessorRunContext,
  sql: string
): Promise<T[]> {
  const controller = new AbortController();
  ctx.jobContext.on('cancel', async () => controller.abort());
  const response = await ctx.ch.query({
    query: sql,
    format: 'JSONEachRow',
    abort_signal: controller.signal,
  });
  // `ResultSet.json<T>()` resolves to `T` itself, not `T[]` — the row type has to
  // be passed as the array.
  return await response.json<T[]>();
}

/**
 * app_block_ids with an `App_Open` event since the watermark.
 *
 * 🔴 FAILS SOFT, AND THE ASYMMETRY WITH getAllTimeOpenCounts IS THE WHOLE POINT.
 * This half only DISCOVERS candidates; it cannot corrupt a number. Degrading to
 * "no new plays this run" is self-healing — `setLastUpdate()` still runs, but the
 * watermark the NEXT run reads still covers the gap, so the plays this run missed
 * are picked up then. (`base.metrics` also widens `lastUpdate` by 2 minutes.)
 *
 * Before this, a ClickHouse blip took `install_count` down with it: this read
 * happens BEFORE the `if (!affected.length) return`, so on a quiet cycle with
 * nothing to do at all, a throw here aborted `update()`, `setLastUpdate()` never
 * ran, and the store's `popular` sort (`install_count DESC`) froze for the whole
 * outage — a pure-Postgres counter held hostage by a ClickHouse outage, with a
 * retry of exactly the same shape. This processor was pure Postgres before the
 * `open_count` work; that regression is not one it gets to introduce.
 *
 * The COUNT read (getAllTimeOpenCounts) deliberately does NOT do this: a partial
 * or empty answer there is written over real counts as 0. Discovery degrades,
 * counting fails the run. Do not "make these consistent".
 *
 * A cancelled job is NOT a ClickHouse failure — `checkIfCanceled()` rethrows it
 * rather than letting it be swallowed into "no plays".
 *
 * The pre-migration failure mode needs none of this: see the `toString(type)` note
 * in appListing.metrics.sql.ts, which is why this query returns an EMPTY SET rather
 * than erroring until the `App_Open` Enum16 widening is applied to production.
 */
async function getRecentlyOpenedBlockIds(ctx: MetricProcessorRunContext): Promise<string[]> {
  return fetchRecentlyOpenedBlockIds(
    ctx.lastUpdate.toISOString(),
    (sql) => chCancellableQuery<AppOpenRecentRow>(ctx, sql),
    (error) => {
      // Rethrows if the job was canceled — an aborted query is not a ClickHouse
      // failure, and must not be reported as "no plays".
      ctx.jobContext.checkIfCanceled();
      log('appListingMetrics play-discovery read failed; continuing without it', error);
      // 🔴 THE AGGREGABLE SIGNAL, and the reason the log line beside it is not
      // enough. A degraded run is INDISTINGUISHABLE from a quiet one — both yield
      // an empty candidate set and an unchanged `open_count` — so the only way to
      // tell "blipped once" from "dead for a week" is a rate over time, which one
      // Axiom warning per run cannot express as an alert. The counter makes
      // PERSISTENCE alertable; the log keeps the per-run attribution (the error
      // message) that a label-free counter deliberately does not carry.
      recordAppListingOpenDiscoveryDegrade();
      logToAxiom({
        type: 'warning',
        name: 'app-listing-metrics-open-discovery-degraded',
        message:
          'AppListing metrics could not read App_Open discovery from ClickHouse; this run recomputes install_count only and picks up missed plays on the next run',
        details: { error: (error as Error)?.message },
      }).catch();
    }
  );
}

async function getAffectedListings(
  ctx: MetricProcessorRunContext,
  recentlyOpenedBlockIds: string[]
): Promise<AffectedListing[]> {
  const query = await ctx.pg.cancellableQuery<{ id: string; app_block_id: string | null }>(
    AFFECTED_APPROVED_LISTINGS_SQL,
    [ctx.lastUpdate, recentlyOpenedBlockIds]
  );
  ctx.jobContext.on('cancel', query.cancel);
  const rows = await query.result();
  // ULIDs sort lexicographically; dedupe defensively.
  const byId = new Map<string, AffectedListing>();
  for (const row of rows) byId.set(row.id, { id: row.id, appBlockId: row.app_block_id });
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * ALL-TIME deduped play count per app_block_id, for every affected on-site listing.
 *
 * 🔴 FAILS HARD, unlike the discovery read above. `open_count` is DERIVED — a block
 * missing from this map is WRITTEN AS 0, not left alone — so a partial or empty
 * answer here does not degrade the run, it silently zeroes real published counts.
 * Failing the run is the correct outcome: the counts stay at their last good values
 * and the next run recomputes them.
 *
 * CHUNKED at APP_OPEN_CH_CHUNK_SIZE — its OWN constant, not the Postgres batch size
 * — because the `IN` list has a hard ceiling this read can genuinely reach
 * (measured: 8,000 ids => `Code: 62 Max query size exceeded`; the arithmetic puts
 * the exact ceiling at 7,696 ids). Combined with the fail-hard above, one over-long
 * query would take `install_count` down with it. But chunking is NOT free here:
 * every chunk is a full `actions` scan whose cost is flat in the `IN` list size, so
 * the chunk count IS the cost, and it is also the number of chances to hit that
 * fail-hard path. Hence a large ClickHouse chunk (2,000, ~3.8x under the ceiling)
 * against a small Postgres batch (200). See the ceiling note on
 * `fetchAppOpenCounts`.
 */
async function getAllTimeOpenCounts(
  ctx: MetricProcessorRunContext,
  affected: AffectedListing[]
): Promise<Map<string, number>> {
  const appBlockIds = affected.map((l) => l.appBlockId).filter((id): id is string => !!id);
  return fetchAppOpenCounts(
    appBlockIds,
    (sql) => chCancellableQuery<AppOpenCountRow>(ctx, sql),
    APP_OPEN_CH_CHUNK_SIZE
  );
}
