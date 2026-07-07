import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_METRIC_UPSERT_SQL,
} from '~/server/metrics/appListing.metrics.sql';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:appListing');
const BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// App Store Listings (W13) — AllTime-only rollup for AppListingMetric.
//
// AppListingMetric is a SINGLE row per listing keyed by `app_listing_id` (no
// `timeframe` column, like Model3DMetric). This processor owns ONLY the
// install/connect counters:
//
//   • installCount  — on-site listings: count of ACTIVE BlockUserSubscription
//     rows for the listing's app_block_id. "Active" = `enabled = true`, matching
//     how app-analytics.service.ts defines the live install base (total vs
//     enabled). BlockUserSubscription has NO soft-delete/`deletedAt` column; a
//     toggle-off flips `enabled=false` (which bumps `updated_at` via @updatedAt,
//     so the incremental affected-query catches it). A hard uninstall (row DELETE)
//     is NOT catchable incrementally — see the SQL note in appListing.metrics.sql.
//
//   • connectCount  — off-site connect listings: count of OauthConsent rows for
//     the listing's connect_client_id (→ OauthClient.id → OauthConsent.clientId).
//     OauthConsent has NO soft-delete column, so a consent revocation DELETEs the
//     row → a bare COUNT(*) is the correct "active grants" number.
//
// 🔴 OWNERSHIP CONTRACT: `thumbs_up_count` / `thumbs_down_count` are owned by the
// SYNCHRONOUS writer in app-listing-review.service.ts (upsert tx). This job MUST
// NEVER write those two columns — the ON CONFLICT DO UPDATE names ONLY
// install_count / connect_count / updated_at, so a metric row that already exists
// (created by the thumbs writer) keeps its thumbs untouched. On CREATE, thumbs
// default to 0 (schema default), correct for a never-reviewed listing.
//
// UN-SOURCED (left at their schema default 0, deliberately NOT populated — no
// server-side source table exists): `open_count`, `visit_count`, `tipped_count`,
// `tipped_amount_count`. Open/visit are never recorded server-side; AppListing is
// not a BuzzTip entity (BuzzTip.entityId is Int, AppListing.id is a string ULID).
// If a source is ever added, add a task here for it.
// ---------------------------------------------------------------------------

export const appListingMetrics = createMetricProcessor({
  name: 'AppListing',
  async update(ctx) {
    // 1. Collect affected approved listing ids (string ULIDs — the shared
    //    number-typed getAffected helper can't be reused, so this is inline).
    const affected = await getAffectedListingIds(ctx);
    log('appListingMetrics update', affected.length, 'affected listings');
    if (!affected.length) return;

    // 2. Batched live-recompute + upsert (install/connect only; thumbs untouched).
    const tasks: Task[] = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('appListing upsert batch', i + 1, 'of', tasks.length);
      const query = await ctx.pg.cancellableQuery(APP_LISTING_METRIC_UPSERT_SQL, [ids]);
      ctx.jobContext.on('cancel', query.cancel);
      await query.result();
      log('appListing upsert batch', i + 1, 'done');
    });
    await limitConcurrency(tasks, 5);
  },
  // No AppListingRank table exists — the `popular` store sort reads
  // AppListingMetric directly. Only `update` is implemented (no refreshRank).
});

async function getAffectedListingIds(ctx: MetricProcessorRunContext): Promise<string[]> {
  const query = await ctx.pg.cancellableQuery<{ id: string }>(AFFECTED_APPROVED_LISTINGS_SQL, [
    ctx.lastUpdate,
  ]);
  ctx.jobContext.on('cancel', query.cancel);
  const rows = await query.result();
  // ULIDs sort lexicographically; dedupe defensively.
  return [...new Set(rows.map((r) => r.id))].sort();
}
