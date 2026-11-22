import type { ListingRecommendRollup } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The store card's stats rules: the recommend rollup, the review count and the play count.
 *
 * PURE: no database, env or cache import, so any reader (the store projections in
 * `app-listing.service.ts`, which re-exports these, and the listing read model's parity test,
 * `listing-card-parity.test.ts`) uses the exact functions without that module's import graph.
 */

/**
 * The fewest counted reviews (moderator-excluded ones are already left out of the
 * counters) at which a listing shows a recommend PERCENTAGE. Below it the counts still
 * travel and `recommendPct` is `null`, so one review never reads "100% recommend (1)".
 *
 * 🔴 The only place this rule lives. Clients branch on `recommendPct == null` and
 * `reviewCount === 0`, never on the number, so a client must not compare a review count
 * against a threshold of its own. Nothing enforces that mechanically. The top-rated sort
 * (`listingBayesianSortKey`) is independent.
 */
export const LISTING_RECOMMEND_PCT_MIN_REVIEWS = 5;

/**
 * Compute the recommend rollup from an `AppListingMetric` row (or null when the
 * P5 rollup job hasn't populated one yet — every count reads 0, pct null).
 * `recommendPct` is also null below {@link LISTING_RECOMMEND_PCT_MIN_REVIEWS}.
 */
export function recommendRollup(
  metric: { thumbsUpCount: number; thumbsDownCount: number } | null | undefined
): ListingRecommendRollup {
  const up = metric?.thumbsUpCount ?? 0;
  const down = metric?.thumbsDownCount ?? 0;
  const total = up + down;
  return {
    recommendedCount: up,
    notRecommendedCount: down,
    recommendPct: total >= LISTING_RECOMMEND_PCT_MIN_REVIEWS ? up / total : null,
  };
}

/**
 * The columns `cardOpenCount` reads. Widened from `HydratedListing` (which still satisfies
 * it structurally — a pure relaxation, no behaviour change) so the moderator review queue
 * can reuse the REAL projection instead of re-deriving it, the same reason
 * {@link DetailKindDataSource} is relaxed.
 *
 * ⚠️ `kind` IS OPTIONAL FOR THE CALLER'S CONVENIENCE AND THAT COSTS THE COMPILER'S HELP:
 * a select that omits the column no longer fails to typecheck, it silently reads as
 * not-on-site. The off-site mod queue therefore has to name `kind: true` deliberately, and
 * a test pins that it does.
 */
export type CardOpenCountSource = {
  kind?: string | null;
  metric?: { openCount: number } | null;
};

/**
 * The card's play count: a NUMBER for an on-site listing, `null` for an off-site one.
 *
 * 🔴 THE DISCRIMINATION IS THE WHOLE POINT, and `row.metric?.openCount ?? 0` alone —
 * the obvious implementation — is WRONG for every off-site card. `open_count` is
 * `Int NOT NULL DEFAULT 0`, so an off-site row carries a literal `0`; projecting it
 * would render "nobody has ever used this app" for an app whose CTA is a plain
 * `target="_blank"` anchor to a third party, where no on-platform request follows the
 * click and there is therefore nothing trustworthy to count. That number is ABSENT,
 * not zero, and `null` is how the DTO says so (the renderer omits the stat row).
 *
 * 🔴 AND DO NOT OVER-NULL. An on-site listing nobody has opened yet is a genuine `0`.
 * A missing metric row means "no plays recorded yet" ⇒ `0`, the same COALESCE-to-0
 * reading `installCount` uses — NOT `null`.
 *
 * 🔴 DISCRIMINATE ON `kind`, NEVER ON `appBlockId` NULLNESS. They are not the same
 * predicate: `schema.prisma` states at the `appBlockId` field that a natively-created
 * OFF-SITE listing also leaves it NULL, so an `appBlockId`-based test would be right
 * by accident on some rows and wrong on others.
 *
 * The positive `=== 'onsite'` test (rather than `!== 'offsite'`) is deliberate: it
 * fails CLOSED to `null` for any kind added later, because an omitted stat row is
 * honest about an unmeasured app while a `0` is a false claim about it. That property
 * is GUARDED, not merely stated — see the unknown-future-kind case in
 * `__tests__/app-listing.service.test.ts`; every other fixture there is onsite/offsite
 * and cannot tell this form apart from the fail-OPEN `=== 'offsite'` one.
 *
 * ✅ MERGE-ORDER CONSTRAINT — DISCHARGED. THIS PARAGRAPH IS RE-DERIVED, NOT EDITED
 * AROUND, SO READ IT RATHER THAN THE ONE IT REPLACES.
 *
 * It used to open "🔴 READ BEFORE SHIPPING THE RENDERER (Stage 4). NOTHING WRITES
 * `open_count` YET. `appListing.metrics.sql.ts` populates `install_count` only — its
 * own suite asserts `expect(upsert).not.toContain('open_count')`", and it required the
 * renderer either to wait for #4653 or to ship behind a flag, on the grounds that a
 * premature renderer would print "0 plays" on every on-site app INCLUDING heavily used
 * ones — by this field's own standard the worst outcome available, and on a public
 * surface.
 *
 * Every clause of that is now false, checked rather than assumed:
 *   · #4653 IS MERGED (`f9f81dcfb5`, "derive app_listing_metrics.open_count from
 *     App_Open events"), and #4652 before it (`6ff42aed42`) ships the App_Open events
 *     it derives from;
 *   · `appListing.metrics.sql.ts` names `open_count` in its INSERT and ON CONFLICT
 *     lists, and the suite assertion quoted above has INVERTED — the same file now
 *     asserts `toContain('COALESCE(oc."open_count", 0)')` and
 *     `toContain('"open_count" = EXCLUDED."open_count"')`;
 *   · the count is DERIVED from an all-time read on every rollup run rather than
 *     accumulated, so there is no backfill step gating correctness — a listing's
 *     number becomes right the first time the job covers it.
 *
 * The renderer (stage 4) therefore ships unflagged, and the flag this paragraph
 * declined to build is still not built and is no longer wanted.
 *
 * ⚠️ WHAT IS **NOT** CLAIMED HERE: that the rollup has already RUN over the whole
 * catalog in any given environment. That is an operational fact about a scheduled
 * job, not a property of this code — an on-site listing whose row the job has not yet
 * covered reads a truthful-by-the-DTO's-rule `0` until it does.
 */
export function cardOpenCount(row: CardOpenCountSource): number | null {
  if (row.kind !== 'onsite') return null;
  return row.metric?.openCount ?? 0;
}

/**
 * The card's review count: the counted reviews behind the recommend rollup, recommended plus not
 * recommended. `projectListingCard` and `projectListingDetail` both use it, so the card and the
 * detail page never count reviews differently.
 */
export function listingReviewCount(
  recommend: Pick<ListingRecommendRollup, 'recommendedCount' | 'notRecommendedCount'>
): number {
  return recommend.recommendedCount + recommend.notRecommendedCount;
}
