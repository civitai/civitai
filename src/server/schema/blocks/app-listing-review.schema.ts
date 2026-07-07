import * as z from 'zod';

/**
 * App Store Listings (W13) — REVIEW (thumbs/recommend) write + read schemas.
 *
 * Backs the NEW `appListings.upsertReview` / `appListings.getMyReview` /
 * `appListings.listReviews` procs against the durable `AppListingReview` table
 * (Steam-style RECOMMEND — a boolean thumbs-up/down, NOT the legacy AppBlock
 * 5-star). Eligibility (enforced in the service): any signed-in user EXCEPT the
 * listing owner, for BOTH `onsite` and `offsite` kinds, with NO install/usage
 * gate (the locked W13 decision). One review per (listing, user) via the DB
 * unique `app_listing_reviews_listing_user_uniq` (an upsert, not a 2nd row).
 *
 * Imports ONLY zod, so this module is safe to pull into the client bundle (the
 * review form reuses `LISTING_REVIEW_DETAILS_MAX` as the single source of truth
 * for the textarea cap).
 *
 * The write path SYNCHRONOUSLY feeds `AppListingMetric.thumbsUp/DownCount` in the
 * same tx (delta vs the prior review) so the existing "N% recommend (M)" rollup
 * on the store card/detail goes live — there is no batch rollup job.
 */

/**
 * Free-text `details` cap. Matches the off-site report/description bound
 * (`OFFSITE_REPORT_DETAILS_MAX` = 2000) — a sane sibling limit for a short
 * review body (the legacy AppBlock 10k cap is a full write-up; a recommend blurb
 * is shorter). The column is `text` (no DB length), so this zod cap + the
 * service re-trim/re-assert are the only bounds.
 */
export const LISTING_REVIEW_DETAILS_MAX = 2000;

/** Shared listing-id shape (an `apl_<ULID>`), mirroring the other listing schemas. */
const appListingId = z.string().min(1).max(64);

/**
 * USER upsert of their review for a listing. `recommended` is the thumbs value
 * (true = recommend); `details` is an OPTIONAL bounded blurb. The reviewer is
 * ALWAYS bound to `ctx.user.id` in the service (no user field here); the owner /
 * approved-state / one-per-(listing,user) gates are all enforced server-side.
 */
export const upsertAppListingReviewSchema = z.object({
  appListingId,
  recommended: z.boolean(),
  details: z.string().max(LISTING_REVIEW_DETAILS_MAX).optional(),
});
export type UpsertAppListingReviewInput = z.infer<typeof upsertAppListingReviewSchema>;

/** USER read of their OWN review for a listing (form prefill), or null. */
export const getMyAppListingReviewSchema = z.object({ appListingId });
export type GetMyAppListingReviewInput = z.infer<typeof getMyAppListingReviewSchema>;

/**
 * PUBLIC keyset-paginate a listing's reviews, NEWEST-first. Excludes mod-excluded
 * / tos-violation rows (a future mod action takes effect immediately). `limit`
 * capped at 50; `cursor` is the last row's numeric id (autoincrement, monotonic).
 */
export const listAppListingReviewsSchema = z.object({
  appListingId,
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListAppListingReviewsInput = z.infer<typeof listAppListingReviewsSchema>;

/**
 * Public-safe review projection (the reviewer's public chip + the review body).
 * No moderation flags, no email/PII beyond the standard `{id,username,image}`.
 */
export type AppListingReviewListItem = {
  id: number;
  recommended: boolean;
  details: string | null;
  createdAt: Date;
  user: { id: number; username: string | null; image: string | null } | null;
};

/** The viewer's own review (form-prefill shape), or null. */
export type MyAppListingReview = {
  id: number;
  recommended: boolean;
  details: string | null;
  createdAt: Date;
} | null;
