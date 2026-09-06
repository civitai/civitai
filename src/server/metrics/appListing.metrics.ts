import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_METRIC_UPSERT_SQL,
  buildAppOpenCountSql,
  buildAppOpenRecentBlockIdsSql,
} from '~/server/metrics/appListing.metrics.sql';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:appListing');
const BATCH_SIZE = 200;

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
// 🔴 RECOMPUTABILITY HAS ONE HOLE. The recompute joins `details.appBlockId` to
// `AppListing.appBlockId`, and that relation is `onDelete: SetNull` — deleting an
// AppBlock nulls the listing's `app_block_id` and every historical play row for it
// becomes permanently unjoinable. If that becomes a real case, carry the listing
// id in `details` as well.
//
// NOT POPULATED (left at their schema default 0 — no reader today, and each maps
// to a feature that isn't live): `connect_count` (off-site OAuth-connect grants —
// OAuth-connect submission is a locked-deferred product decision, so there are no
// connect listings yet and nothing reads the count), `visit_count`, `tipped_count`,
// `tipped_amount_count` (visit is never recorded server-side; AppListing is not a
// BuzzTip entity — BuzzTip.entityId is Int, AppListing.id is a string ULID).
// Populate each with the PR that ships its consumer, not speculatively.
// ---------------------------------------------------------------------------

export const appListingMetrics = createMetricProcessor({
  name: 'AppListing',
  async update(ctx) {
    // 1. Ask ClickHouse which app blocks were PLAYED since the watermark. Nothing
    //    in Postgres moves when a play happens, so without this a listing whose
    //    only change is new plays would never be recomputed. (ClickHouse-first
    //    affected discovery — same shape as model3d.metrics.ts getDownloadTasks.)
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
    const openCounts = await getAllTimeOpenCounts(ctx, affected);

    // 4. Batched live-recompute + upsert (install/open only; thumbs untouched).
    const tasks: Task[] = chunk(affected, BATCH_SIZE).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('appListing upsert batch', i + 1, 'of', tasks.length);
      const ids = batch.map((l) => l.id);
      // Parallel arrays for the upsert's `unnest($2, $3)` join. Keyed through a Map
      // so a duplicated app_block_id can never widen the join and trip the
      // "ON CONFLICT DO UPDATE cannot affect row a second time" error.
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
 * app_block_ids with an `App_Open` event since the watermark.
 *
 * Errors are NOT swallowed, deliberately: a broken ClickHouse read must not
 * silently degrade into "no plays", which would then be written as 0 over real
 * counts. The one failure mode this DOES tolerate is the pre-migration one — see
 * the `toString(type)` note in appListing.metrics.sql.ts, which is why this query
 * returns an empty set (rather than throwing) until the `App_Open` Enum16 widening
 * is applied to production.
 */
async function getRecentlyOpenedBlockIds(ctx: MetricProcessorRunContext): Promise<string[]> {
  const rows = await ctx.ch.$query<{ appBlockId: string }>(
    buildAppOpenRecentBlockIdsSql(ctx.lastUpdate.toISOString())
  );
  return [...new Set(rows.map((r) => r.appBlockId).filter(Boolean))];
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

/** ALL-TIME deduped play count per app_block_id, for every affected on-site listing. */
async function getAllTimeOpenCounts(
  ctx: MetricProcessorRunContext,
  affected: AffectedListing[]
): Promise<Map<string, number>> {
  const appBlockIds = [
    ...new Set(affected.map((l) => l.appBlockId).filter((id): id is string => !!id)),
  ];
  // `IN ()` is a syntax error, and there is nothing to ask about anyway.
  if (!appBlockIds.length) return new Map();

  const rows = await ctx.ch.$query<{ appBlockId: string; openCount: number | string }>(
    buildAppOpenCountSql(appBlockIds)
  );
  return new Map(rows.map((r) => [r.appBlockId, Number(r.openCount)]));
}
