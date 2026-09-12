/**
 * Inline RECENT-REVIEWS block — bounding policy (pure, React-free).
 *
 * Backs the fixed-height review block the unified listing detail renders BELOW
 * the description and ABOVE the "More in <category>" discovery rail. Pure so the
 * correctness coverage lands in the node `unit` project — the fast, blocking
 * suite CI runs on every PR — rather than only in the report-only browser tier
 * (same rationale as `related-listings.ts`).
 *
 * ## 🔴 THE BOUND IS THE DESIGN, NOT A PERFORMANCE DETAIL
 *
 * A tester asked for the reviews section to MOVE up, whole, under the
 * description. It was deliberately NOT moved: the full list is unbounded, so
 * hoisting it would push the discovery rail (and the discussion) down by an
 * arbitrary amount for exactly the viewers most likely to want them — the ones
 * who read the listing and didn't convert. That is the same reasoning the rail's
 * own placement comment in `AppListingDetailBody.tsx` already records.
 *
 * What went up instead is a block that CANNOT grow: at most
 * `INLINE_RECENT_REVIEWS_LIMIT` rows plus a "See more reviews" link to the full
 * list, which stays at the bottom and remains the jump target for the Details
 * rail's "Reviews" row. **A block that can grow without limit defeats the whole
 * reason this shape was chosen**, so the cap is enforced here, centrally, and
 * asserted against an over-long input rather than against a fixture that happens
 * to be short.
 */

import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';

/**
 * How many reviews the inline block shows. 3 — the low end of the requested
 * "3-4", because this block sits between the description and the discovery rail
 * and its whole job is to be a taste of the reviews rather than the reviews.
 *
 * 🔴 Read this constant; never restate the number at a call site. It is also the
 * `limit` handed to `appListings.listReviews`, so the query and the render agree
 * by construction — a server that returned more could not widen the block, and a
 * render that wanted more could not silently ask for it.
 */
export const INLINE_RECENT_REVIEWS_LIMIT = 3;

/**
 * Cap a newest-first review page to the inline block's bound.
 *
 * Order is the SERVER's (`listReviews` is keyset-paginated newest-first); this
 * does not re-sort, because re-sorting here would be a second, divergent opinion
 * about recency that nothing keeps in step with the query. It only bounds.
 *
 * Defensive against a `null`/`undefined` page (the query's pre-data state) and
 * against holes in the array, so the caller never has to spell those two cases
 * out beside the cap and get one of them wrong.
 */
export function selectRecentReviews(
  items: (AppListingReviewListItem | null | undefined)[] | null | undefined,
  limit: number = INLINE_RECENT_REVIEWS_LIMIT
): AppListingReviewListItem[] {
  if (limit <= 0) return [];
  const picked: AppListingReviewListItem[] = [];
  for (const item of items ?? []) {
    if (picked.length >= limit) break;
    if (!item) continue;
    picked.push(item);
  }
  return picked;
}

// 🔴 THERE IS DELIBERATELY NO `shouldRenderRecentReviews` HERE. One existed and
// was deleted before merge: it read `selectRecentReviews(items, limit).length > 0`,
// which is an expression `AppListingRecentReviews` already computes — it needs the
// array to render — so the only ways to "use" it were a redundant second pass or a
// wrapper over `.length > 0`. It had ZERO production call sites and two tests in
// the node tier, which together read as coverage of the render-or-not policy while
// touching none of it: the mutant that killed them mutated unreachable code, and
// the live guard was exercised only by the component tier.
//
// It also could not have covered that policy even fully wired, because the policy
// has TWO clauses — empty AND loading — and this function could only ever see the
// first. The render decision lives with the thing that renders; see the guard in
// `AppListingRecentReviews.tsx` and the reasoning above it.
