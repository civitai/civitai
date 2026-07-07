import { dbRead, dbWrite } from '~/server/db/client';
import {
  LISTING_REVIEW_DETAILS_MAX,
  type AppListingReviewListItem,
  type ListAppListingReviewsInput,
  type MyAppListingReview,
  type UpsertAppListingReviewInput,
} from '~/server/schema/blocks/app-listing-review.schema';
import { bustCacheTag } from '~/server/utils/cache-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

/**
 * App Store Listings (W13) — REVIEW (thumbs/recommend) write + read service.
 *
 * The write half of `AppListingReview` (the read/DISPLAY of the recommend
 * rollup + the model already existed — see `app-listing.service.recommendRollup`
 * + the P0 `AppListingMetric` table). Steam-style RECOMMEND: a boolean
 * thumbs-up/down (NOT the legacy AppBlock 5-star `appBlockReview.service`).
 *
 * ELIGIBILITY (locked W13 decision — enforced here; the router adds the flag +
 * auth gates): any signed-in user EXCEPT the listing OWNER, for BOTH `onsite`
 * and `offsite` kinds, with NO install/usage gate (the legacy 5-star path's
 * enabled-install gate deliberately does NOT apply). One review per
 * (listing, user) via the DB unique (an upsert, not a 2nd row).
 *
 * SYNCHRONOUS METRIC FEED (locked decision — no batch rollup job): the write
 * adjusts `AppListingMetric.thumbsUp/DownCount` by the DELTA vs the user's PRIOR
 * review IN THE SAME TX, so the existing "N% recommend (M)" rollup on the store
 * card/detail goes live the instant a review lands. The metric row is CREATED
 * (zeros) if absent — most listings have no row today (no writer before this).
 *
 * DARK: all surfaces are gated at the router (the mod-segmented App Blocks flag);
 * this service does no auth of its own beyond the owner / approved-state gates.
 */

// The only review-derived cached value feeding a visible surface is the
// store-wide Bayesian-prior recommend MEAN (`app-listing.service`'s
// getGlobalRecommendMean, tag below, 1h). The per-listing card/detail counts are
// read straight off the AppListingMetric rollup (uncached), so only the global
// mean needs busting when a review shifts the counters.
const GLOBAL_RECOMMEND_MEAN_TAG = 'app-listing:recommend-global-mean';

/**
 * Bust the store-wide recommend-mean cache after a review write. Fire-and-forget
 * (a cache-bus outage must never fail the review).
 */
async function bustRecommendMeanCache(): Promise<void> {
  await bustCacheTag([GLOBAL_RECOMMEND_MEAN_TAG]);
}

/** The compound-unique lookup key for `AppListingReview(appListingId, userId)`. */
function reviewKey(appListingId: string, userId: number) {
  return { appListingId_userId: { appListingId, userId } };
}

export type UpsertAppListingReviewResult = {
  review: {
    id: number;
    appListingId: string;
    userId: number;
    recommended: boolean;
    details: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  /** True only on the CREATE branch (no prior review for this (listing, user)). */
  isNewReview: boolean;
};

/**
 * Create-or-update the caller's review for a listing, keyed on the unique
 * (app_listing_id, user_id), and feed the recommend metric SYNCHRONOUSLY.
 *
 * Gates (all enforced here):
 *   1. Listing must EXIST and be `approved` — a missing / draft / pending /
 *      rejected / removed listing is not reviewable (BAD_REQUEST / NOT_FOUND).
 *   2. NO SELF-REVIEW — the listing owner cannot review their own listing
 *      (FORBIDDEN), for both kinds.
 *   3. `details` is trimmed + length-capped (defense-in-depth on top of the zod
 *      cap — this fn is exported + unit-tested directly); whitespace-only → null.
 *
 * Metric DELTA (in the SAME tx as the review upsert): adjust thumbsUp/Down vs the
 * user's PRIOR NON-EXCLUDED review —
 *   - no prior (or prior was mod-excluded) → +1 to the chosen bucket.
 *   - prior, same `recommended` → no counter change (details-only edit).
 *   - prior, flipped `recommended` → −1 old bucket, +1 new bucket.
 * The metric row is created (zeros) if absent; a decrement can never drive a
 * counter negative (a −1 only happens when a prior counted review existed, which
 * itself added +1 — and a defensive clamp back-stops any inconsistency).
 */
export async function upsertAppListingReview(opts: {
  userId: number;
  input: UpsertAppListingReviewInput;
}): Promise<UpsertAppListingReviewResult> {
  const { userId, input } = opts;
  const { appListingId, recommended } = input;

  // Gate 3: trim + re-assert the cap (defense-in-depth). Whitespace-only → null.
  const trimmed = input.details?.trim() ?? '';
  if (trimmed.length > LISTING_REVIEW_DETAILS_MAX) {
    throw throwBadRequestError(
      `Review is too long (max ${LISTING_REVIEW_DETAILS_MAX.toLocaleString()} characters)`
    );
  }
  const details = trimmed.length > 0 ? trimmed : null;

  // Gate 1+2: the listing must exist, be approved, and NOT be owned by the caller.
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: { id: true, userId: true, status: true },
  });
  if (!listing) throw throwNotFoundError('Listing not found');
  if (listing.userId === userId) {
    throw throwAuthorizationError('You cannot review your own app');
  }
  if (listing.status !== 'approved') {
    throw throwBadRequestError('This app is not available for review');
  }

  const review = await dbWrite.$transaction(async (tx) => {
    // Read the prior review (if any) to compute the metric delta. The DB unique
    // makes the upsert itself atomic; a concurrent first-review by the SAME user
    // is impossible (they're one user) so the read-then-upsert is race-safe here.
    const prior = await tx.appListingReview.findUnique({
      where: reviewKey(appListingId, userId),
      select: { id: true, recommended: true, exclude: true },
    });

    // A prior review contributes to a bucket ONLY when it is non-excluded. The
    // freshly written review keeps the prior `exclude` (create → false); we never
    // flip `exclude` on the write path (that's the deferred mod control), so
    // "will count" == "prior wasn't excluded" (or a brand-new, non-excluded row).
    const priorCounted = prior != null && !prior.exclude;
    const willCount = prior != null ? !prior.exclude : true;

    let upDelta = 0;
    let downDelta = 0;
    if (priorCounted) {
      if (prior!.recommended) upDelta -= 1;
      else downDelta -= 1;
    }
    if (willCount) {
      if (recommended) upDelta += 1;
      else downDelta += 1;
    }

    const saved = await tx.appListingReview.upsert({
      where: reviewKey(appListingId, userId),
      create: { appListingId, userId, recommended, details },
      update: { recommended, details },
      select: {
        id: true,
        appListingId: true,
        userId: true,
        recommended: true,
        details: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Feed the metric in the SAME tx. Only touch it when there's a real delta (a
    // details-only edit leaves the counters untouched). The upsert CREATES the row
    // (clamped ≥0) when absent, else applies the atomic per-counter increments.
    if (upDelta !== 0 || downDelta !== 0) {
      await tx.appListingMetric.upsert({
        where: { appListingId },
        create: {
          appListingId,
          thumbsUpCount: Math.max(0, upDelta),
          thumbsDownCount: Math.max(0, downDelta),
        },
        update: {
          ...(upDelta !== 0 ? { thumbsUpCount: { increment: upDelta } } : {}),
          ...(downDelta !== 0 ? { thumbsDownCount: { increment: downDelta } } : {}),
        },
      });
      // Defensive clamp — a counter must NEVER go negative even if the metric row
      // drifted out of sync with the review rows (e.g. a future mod re-count). Each
      // updateMany is atomic; it's a no-op in the normal (consistent) case.
      if (upDelta < 0) {
        await tx.appListingMetric.updateMany({
          where: { appListingId, thumbsUpCount: { lt: 0 } },
          data: { thumbsUpCount: 0 },
        });
      }
      if (downDelta < 0) {
        await tx.appListingMetric.updateMany({
          where: { appListingId, thumbsDownCount: { lt: 0 } },
          data: { thumbsDownCount: 0 },
        });
      }
    }

    return { saved, isNewReview: prior == null };
  });

  await bustRecommendMeanCache().catch(() => undefined);
  return { review: review.saved, isNewReview: review.isNewReview };
}

/** The caller's OWN review for a listing (form prefill), or null. */
export async function getMyAppListingReview(
  appListingId: string,
  userId: number
): Promise<MyAppListingReview> {
  const row = await dbRead.appListingReview.findUnique({
    where: reviewKey(appListingId, userId),
    select: { id: true, recommended: true, details: true, createdAt: true },
  });
  return row ?? null;
}

/**
 * Keyset-paginated list of a listing's reviews, NEWEST-first. Excludes
 * mod-excluded (`exclude`) AND `tosViolation` rows, so a future mod action takes
 * effect on the visible list immediately. Keyset on `id DESC` (autoincrement,
 * monotonic — `createdAt` can tie). Returns the page + `nextCursor` (last row's
 * id) when more rows exist.
 */
export async function listAppListingReviews(
  input: ListAppListingReviewsInput
): Promise<{ items: AppListingReviewListItem[]; nextCursor?: number }> {
  const take = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const rows = await dbRead.appListingReview.findMany({
    where: {
      appListingId: input.appListingId,
      exclude: false,
      tosViolation: false,
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: take + 1,
    select: {
      id: true,
      recommended: true,
      details: true,
      createdAt: true,
      user: { select: { id: true, username: true, image: true } },
    },
  });
  const items = rows.slice(0, take);
  const nextCursor = rows.length > take ? items[items.length - 1]?.id : undefined;
  return { items, nextCursor };
}
