import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { bustCacheTag, queryCache } from '~/server/utils/cache-helpers';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * App Blocks marketplace review service (F-E "marketplace" cluster).
 *
 * Mirrors the model-review service (resourceReview.service.ts) but against the
 * parallel `app_block_reviews` table. ALL surfaces are gated dark behind the
 * mod-segmented appBlocks flag at the tRPC layer — this service does no auth of
 * its own beyond the anti-abuse gates documented per-method.
 */

// Bayesian shrinkage prior strength (C) for the marketplace `rating` sort. The
// score is (C*m + SUM(rating)) / (C + n): a few-review app is pulled toward the
// global mean `m`, so it can't outrank a many-review app on a single 5★. Taxonomy
// const (no migration); tune freely. 10 ≈ "trust the app's own average once it
// has ~10 reviews".
export const BAYES_MIN_REVIEWS = 10;

// ---------------------------------------------------------------------------
// Cache: rating totals (avg + count) per app block.
// ---------------------------------------------------------------------------

const ratingTag = (appBlockId: string) => `app-rating:${appBlockId}`;
// Global-mean tag — busted alongside any single-app bust because adding/removing
// a review shifts the marketplace-wide Bayesian prior `m` (kept in sync with
// block-registry.service.ts's getGlobalMeanRating tag).
const GLOBAL_MEAN_TAG = 'app-rating:global-mean';

/**
 * Bust the getAppRatingTotals cache for one app AND the global-mean cache (a
 * review change shifts both the app's avg and the marketplace-wide prior `m`).
 * Fire-and-forget.
 */
export const bustAppRatingCache = async (appBlockId: string) => {
  await bustCacheTag([ratingTag(appBlockId), GLOBAL_MEAN_TAG]);
};

export type AppRatingTotals = { avgRating: number | null; reviewCount: number };

/**
 * AVG(rating) + COUNT(*) for an app block, EXCLUDING:
 *   - moderator-excluded rows (`exclude = true`), and
 *   - the app owner's own review (self-review) — joined via
 *     OauthClient.userId, mirroring resourceReview's `m."userId" != rr."userId"`.
 * Cached 1h, tag `app-rating:<id>` (busted on upsert / delete / setExcluded).
 */
export const getAppRatingTotals = async (appBlockId: string): Promise<AppRatingTotals> => {
  const query = Prisma.sql`
    SELECT
      AVG(abr.rating)::float AS avg_rating,
      COUNT(abr.id)::int     AS review_count
    FROM app_block_reviews abr
    JOIN app_blocks ab ON ab.id = abr.app_block_id
    JOIN "OauthClient" oc ON oc.id = ab.app_id
    WHERE abr.app_block_id = ${appBlockId}
      AND NOT abr.exclude
      -- Exclude the app owner's own review from the aggregate (self-review).
      AND oc."userId" IS DISTINCT FROM abr.user_id
  `;
  const cacheable = queryCache(dbRead, 'getAppRatingTotals', 'v1');
  const rows = await cacheable<{ avg_rating: number | null; review_count: number }[]>(query, {
    ttl: CacheTTL.hour,
    tag: [ratingTag(appBlockId)],
  });
  const row = rows[0];
  return {
    avgRating: row?.avg_rating ?? null,
    reviewCount: row?.review_count ?? 0,
  };
};

// ---------------------------------------------------------------------------
// Anti-abuse gates.
// ---------------------------------------------------------------------------

/** Returns the app owner's userId (via OauthClient) for the given app block. */
async function getAppOwnerUserId(appBlockId: string): Promise<number | null> {
  const row = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { app: { select: { userId: true } } },
  });
  return row?.app.userId ?? null;
}

/** True when the viewer has an ENABLED subscription (install) for the app. */
async function hasEnabledInstall(appBlockId: string, userId: number): Promise<boolean> {
  const row = await dbRead.blockUserSubscription.findFirst({
    where: { appBlockId, userId, enabled: true },
    select: { id: true },
  });
  return !!row;
}

// ---------------------------------------------------------------------------
// Upsert.
// ---------------------------------------------------------------------------

export type UpsertAppBlockReviewInput = {
  appBlockId: string;
  rating: number;
  recommended?: boolean;
  details?: string | null;
};

export type UpsertAppBlockReviewResult = {
  review: { id: number; appBlockId: string; rating: number; recommended: boolean };
  /** True only on the CREATE branch — the reward fires once per (user, app). */
  isFirstReview: boolean;
};

/**
 * Create-or-update the viewer's review for an app block, keyed on the unique
 * (app_block_id, user_id). Anti-abuse gates (all enforced here):
 *   1. rating ∈ [1, 5] (STARS).
 *   2. NO SELF-REVIEW — the app owner cannot review their own app.
 *   3. MUST HAVE INSTALLED — an ENABLED BlockUserSubscription is required.
 *   4. ONE PER (user, app) — the DB unique constraint (an upsert, not a 2nd row).
 *
 * Returns `isFirstReview` so the caller fires the blue-buzz reward ONLY on the
 * first create. Busts the rating cache after the write.
 */
export const upsertAppBlockReview = async ({
  userId,
  appBlockId,
  rating,
  recommended = true,
  details = null,
}: UpsertAppBlockReviewInput & { userId: number }): Promise<UpsertAppBlockReviewResult> => {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw throwBadRequestError('Rating must be a whole number from 1 to 5');
  }

  // Gate 2: no self-review. Reject before any write so the owner can't seed
  // their own (even though it's excluded from the aggregate too).
  const ownerUserId = await getAppOwnerUserId(appBlockId);
  if (ownerUserId == null) throw throwBadRequestError('App block not found');
  if (ownerUserId === userId) {
    throw throwAuthorizationError('You cannot review your own app');
  }

  // Gate 3: must have installed (enabled subscription).
  if (!(await hasEnabledInstall(appBlockId, userId))) {
    throw throwAuthorizationError('Install the app before reviewing it');
  }

  // Gate 1+4: upsert on the unique (app_block_id, user_id). The unique index
  // makes the create-vs-update decision atomic — we read first to know which
  // branch ran (isFirstReview) for the once-per reward, and the unique index
  // guarantees a concurrent double-create can't slip a second row through.
  const existing = await dbWrite.appBlockReview.findUnique({
    where: { appBlockId_userId: { appBlockId, userId } },
    select: { id: true },
  });

  let review: { id: number; appBlockId: string; rating: number; recommended: boolean };
  let isFirstReview: boolean;
  if (!existing) {
    review = await dbWrite.appBlockReview.create({
      data: { appBlockId, userId, rating, recommended, details },
      select: { id: true, appBlockId: true, rating: true, recommended: true },
    });
    isFirstReview = true;
  } else {
    review = await dbWrite.appBlockReview.update({
      where: { id: existing.id },
      data: { rating, recommended, details },
      select: { id: true, appBlockId: true, rating: true, recommended: true },
    });
    isFirstReview = false;
  }

  await bustAppRatingCache(appBlockId).catch(() => undefined);
  return { review, isFirstReview };
};

// ---------------------------------------------------------------------------
// List (keyset).
// ---------------------------------------------------------------------------

export type AppBlockReviewListItem = {
  id: number;
  userId: number;
  rating: number;
  recommended: boolean;
  details: string | null;
  createdAt: Date;
};

/**
 * Keyset-paginated list of an app's reviews, newest first. Excludes mod-excluded
 * rows. Keyset on `id DESC` (id is monotonic; createdAt can tie). Returns the
 * page + a `nextCursor` (the last row's id) when more rows exist.
 */
export const listAppBlockReviews = async ({
  appBlockId,
  cursor,
  limit = 20,
}: {
  appBlockId: string;
  cursor?: number;
  limit?: number;
}): Promise<{ items: AppBlockReviewListItem[]; nextCursor?: number }> => {
  const take = Math.min(Math.max(limit, 1), 50);
  const rows = await dbRead.appBlockReview.findMany({
    where: {
      appBlockId,
      exclude: false,
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: take + 1,
    select: {
      id: true,
      userId: true,
      rating: true,
      recommended: true,
      details: true,
      createdAt: true,
    },
  });
  const items = rows.slice(0, take);
  const nextCursor = rows.length > take ? items[items.length - 1]?.id : undefined;
  return { items, nextCursor };
};

/** The viewer's own review for an app block (or null). */
export const getMyAppBlockReview = async (
  appBlockId: string,
  userId: number
): Promise<AppBlockReviewListItem | null> => {
  const row = await dbRead.appBlockReview.findUnique({
    where: { appBlockId_userId: { appBlockId, userId } },
    select: {
      id: true,
      userId: true,
      rating: true,
      recommended: true,
      details: true,
      createdAt: true,
    },
  });
  return row ?? null;
};

// ---------------------------------------------------------------------------
// Moderator controls.
// ---------------------------------------------------------------------------

/**
 * MOD-ONLY (gated at the router with moderatorProcedure). Flip `exclude` on a
 * review so it drops out of the aggregate + ranking. Busts the rating cache.
 * Mirrors toggleExcludeResourceReview.
 */
export const setAppReviewExcluded = async ({
  id,
  exclude,
}: {
  id: number;
  exclude: boolean;
}): Promise<{ id: number; appBlockId: string; exclude: boolean }> => {
  const updated = await dbWrite.appBlockReview.update({
    where: { id },
    data: { exclude },
    select: { id: true, appBlockId: true, exclude: true },
  });
  await bustAppRatingCache(updated.appBlockId).catch(() => undefined);
  return updated;
};

/** Delete a review (owner self-delete OR mod). Busts the rating cache. */
export const deleteAppBlockReview = async ({
  id,
}: {
  id: number;
}): Promise<{ id: number; appBlockId: string }> => {
  const deleted = await dbWrite.appBlockReview.delete({
    where: { id },
    select: { id: true, appBlockId: true },
  });
  await bustAppRatingCache(deleted.appBlockId).catch(() => undefined);
  return deleted;
};
