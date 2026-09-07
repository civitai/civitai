import type { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
import {
  narrowStoreScope,
  scopeAdmitsListingKind,
  type StoreListingKind,
} from '~/shared/utils/store-visibility-scope';
import {
  LISTING_REVIEW_DETAILS_MAX,
  type AppListingReviewListItem,
  type ListAppListingReviewsInput,
  type MyAppListingReview,
  type SetAppListingReviewExcludeInput,
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
 * thumbs-up/down. (This SUPERSEDED the legacy AppBlock 5-star
 * `appBlockReview.service`, which has since been removed — thumbs are now the
 * only app-review system.)
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
 * MODERATOR CONTROL: `setAppListingReviewExclude` sets the `exclude` flag the table
 * has always carried and moves the same counters by the same shared delta rule — a
 * SOFT HIDE, never a delete (a delete would strand the denormalized counters and
 * re-open the once-per-(user, listing) first-review window; see that function's
 * header). It is `moderatorProcedure`-gated at the router.
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

// ---------------------------------------------------------------------------
// The ONE recommend-aggregate delta rule, and the ONE write that applies it.
//
// `AppListingMetric.thumbsUp/DownCount` is DENORMALIZED and has no recompute — it
// is whatever the sum of the ±1 deltas its writers have applied says it is. So
// every writer MUST agree on (a) which review rows count and (b) how a transition
// maps to a delta. There are exactly TWO (`upsertAppListingReview` and
// `setAppListingReviewExclude`) and a second copy of this arithmetic is how the
// counter silently drifts from the rows — so it is written once, here, and both
// call it.
//
// 🔴 "No recompute" is a TWO-SIDED contract, not a property of this file. The
// `app_listing_metrics` row is ALSO written by the metric processor
// (`src/server/metrics/appListing.metrics.sql.ts`), which deliberately names only
// `install_count` / `open_count` in its INSERT and ON CONFLICT lists so a row
// created here survives the rollup untouched. Both of those counters are FULL
// RECOMPUTES (installs from `block_user_subscriptions`, plays from the ClickHouse
// `App_Open` event stream) — which is what makes that side a legal writer under
// the last line of this paragraph. Each side pins the other:
//   - that side is pinned by `src/server/metrics/__tests__/appListing.metrics.test.ts`
//     ("NEVER writes thumbs_up_count / thumbs_down_count");
//   - this side is pinned by the writer-set ledger in
//     `src/server/services/blocks/__tests__/app-listing-review.mod-exclude.test.ts`,
//     which fails if the caller set GROWS or SHRINKS.
// A third writer is only safe if it brings a full recompute with it.
// ---------------------------------------------------------------------------

/** A review's CONTRIBUTION to the recommend aggregate; `null` = contributes nothing. */
type CountedReview = { recommended: boolean } | null;

/** The per-bucket adjustment to apply to `AppListingMetric`. */
type RecommendMetricDelta = { upDelta: number; downDelta: number };

/**
 * Does this review row feed the recommend aggregate, and into which bucket?
 *
 * 🔴 `exclude` ONLY — deliberately NOT `tosViolation`, even though
 * {@link listAppListingReviews} hides both. The counters have never tracked
 * `tosViolation` (nothing writes it today), so folding it in here would make the
 * live counters disagree with the rows they were accumulated from, with no
 * recount job to repair the difference. If a `tosViolation` writer ever lands it
 * must come with a recount, and this predicate is the single place to widen.
 */
function countedContribution(
  row: { recommended: boolean; exclude: boolean } | null | undefined
): CountedReview {
  if (row == null || row.exclude) return null;
  return { recommended: row.recommended };
}

/**
 * The delta a single review's transition applies to the recommend counters.
 *
 * Exported for direct unit test: it is a pure function of the BEFORE and AFTER
 * contributions, so every transition either writer can produce — create, edit,
 * recommend flip, mod hide, mod unhide, and every no-op — is one call here.
 *
 * IDEMPOTENCE falls out of the shape rather than being bolted on: identical
 * `prior` and `next` contributions cancel to `{0,0}`, so a repeated hide (or a
 * details-only edit) is a zero-delta no-op by construction.
 */
export function recommendMetricDelta(
  prior: CountedReview,
  next: CountedReview
): RecommendMetricDelta {
  let upDelta = 0;
  let downDelta = 0;
  if (prior) {
    if (prior.recommended) upDelta -= 1;
    else downDelta -= 1;
  }
  if (next) {
    if (next.recommended) upDelta += 1;
    else downDelta += 1;
  }
  return { upDelta, downDelta };
}

/**
 * Apply a computed delta to `AppListingMetric` INSIDE the caller's transaction.
 *
 * Only touches the row when there is a real delta (a zero-delta transition leaves
 * the counters and their `updatedAt` alone). The upsert CREATES the row (clamped
 * ≥0) when absent, else applies the atomic per-counter increments.
 *
 * Concurrency note: two users filing the first-ever reviews on a listing with no
 * metric row both take the create branch; this is safe ONLY because Prisma emits a
 * native INSERT … ON CONFLICT DO UPDATE for a single-PK upsert (the loser's insert
 * converts to the increment). If Prisma ever falls back to select-then-insert, the
 * loser's tx would 500 once (retriable — the row then exists).
 */
async function applyRecommendMetricDelta(
  tx: Pick<Prisma.TransactionClient, 'appListingMetric'>,
  appListingId: string,
  { upDelta, downDelta }: RecommendMetricDelta
): Promise<void> {
  if (upDelta === 0 && downDelta === 0) return;

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
  // drifted out of sync with the review rows. Each updateMany is atomic; it's a
  // no-op in the normal (consistent) case.
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

/**
 * The store-scope KIND gate as a Prisma relation fragment on `appListingReview`.
 *
 * The DB-filter twin of the shared boolean {@link scopeAdmitsListingKind}: the
 * predicate form is what the client affordance gate and the write path branch on,
 * this is what the two review READS filter with. Prisma's filter types cannot reach
 * the dependency-free shared module, so the two forms cannot literally be one
 * function — but they can be one *decision*, written once each. Both were open-coded
 * inline before; a third copy is the bug.
 *
 * 🔴 EXHAUSTIVE, mirroring {@link scopeAdmitsListingKind}'s switch rather than
 * testing one scope and letting everything else fall through. The `=== 'public-external'
 * ? … : {}` shape it replaces returned `{}` — NO kind restriction — for every scope
 * that was not literally `public-external`, `none` included. `none` is not supposed
 * to reach here (both callers short-circuit at the proc, and the write middleware
 * rejects it), but "is not supposed to" is precisely the reasoning civitai#3983
 * disproved one file over. A scope that means "sees nothing" must never be spelled
 * as the same fragment as "sees everything".
 *
 * `none` maps to an impossible predicate so the relation can never match; `full`
 * imposes no restriction; `public-external` restricts to offsite.
 */
function listingKindFilterForScope(scope: StoreVisibilityScope) {
  switch (scope) {
    case 'full':
      return {};
    case 'public-external':
      return { kind: 'offsite' } as const;
    case 'none':
      // Matches no row. `app_listings.kind` is `text` (verified against the live
      // column type, not the Prisma type) — so this renders as `kind = '__none__'`
      // and returns EMPTY. That distinction is load-bearing: against a Postgres
      // ENUM column an out-of-domain literal would make the query ERROR, and a 500
      // is not "fail closed", it is a different failure.
      return { kind: '__none__' } as const;
  }
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
  /**
   * The caller's resolved store scope.
   *
   * 🔴 FAIL CLOSED on an absent / unrecognized value — `narrowStoreScope`, never
   * `?? 'full'`. An earlier revision of this parameter defaulted to `full` on the
   * reasoning that "the router ALWAYS passes an explicit scope". That is the exact
   * sentence `listAvailableListings` (app-listing.service.ts) records as
   * EMPIRICALLY FALSE: every caller did pass one there too, and production still
   * reached it with `undefined`, so the `??` fired and served the whole approved
   * catalogue to anonymous callers (civitai#3983). A default is an authorization
   * decision, and on a WRITE path it is a worse one. Latent here only because
   * `applyStoreScope` narrows `undefined` → `none` before the router calls us —
   * i.e. one refactor away from live.
   */
  scope?: StoreVisibilityScope;
}): Promise<UpsertAppListingReviewResult> {
  const { userId, input } = opts;
  const scope = narrowStoreScope(opts.scope);
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
    select: { id: true, userId: true, status: true, kind: true },
  });
  if (!listing) throw throwNotFoundError('Listing not found');

  // Gate 0 — the STORE-SCOPE kind gate, and it runs FIRST of the three below on
  // purpose. A caller whose scope does not admit this listing's kind cannot see the
  // row at all, so they must not be able to distinguish "not yours", "not approved"
  // and "does not exist" through it: all three collapse into the same NOT_FOUND the
  // read path (`getListingDetail` → null → NOT_FOUND) already gives them. Ordering
  // it after the owner/status checks would turn this proc into an existence oracle
  // over the onsite catalogue for the external-only cohort.
  //
  // This is the WRITE-side twin of `listAppListingReviews`'s relation filter
  // (`scope === 'public-external' ? { kind: 'offsite' } : {}`); both call the ONE
  // shared rule so they cannot drift.
  if (!scopeAdmitsListingKind(scope, listing.kind as StoreListingKind)) {
    throw throwNotFoundError('Listing not found');
  }

  if (listing.userId === userId) {
    throw throwAuthorizationError('You cannot review your own app');
  }
  if (listing.status !== 'approved') {
    // 🟡 KNOWN, DELIBERATELY NOT FIXED HERE — a narrow status oracle. A
    // `public-external` caller naming a non-approved OFFSITE listing gets
    // BAD_REQUEST, while a nonexistent id gets NOT_FOUND, so the pair distinguishes
    // "exists but unapproved" from "does not exist" for a population the read path
    // deliberately collapses. Blast radius today is 2 rows (offsite drafts) and
    // AppListing ids are ULIDs, so they are not enumerable — hence out of scope for
    // a fix aimed at the review-gate defect rather than folded in silently.
    // One-line fix when someone wants it: `if (scope !== 'full') throw
    // throwNotFoundError('Listing not found');` ahead of this line, so only a
    // full-scope caller ever learns the difference.
    throw throwBadRequestError('This app is not available for review');
  }

  const review = await dbWrite.$transaction(async (tx) => {
    // Read the prior review (if any) to compute the metric delta — LOCKED.
    //
    // 🔴 `SELECT … FOR UPDATE`, not `findUnique`, because of the OTHER WRITER: under
    // READ COMMITTED a moderator's `setAppListingReviewExclude` committing between
    // this read and the upsert below would make the delta be computed against an
    // `exclude` value that is already stale, so the author's ±1 would land on a row
    // that is no longer counted. Taking the row lock forces the two writers into a
    // serial order on this row.
    //
    // 🟡 THIS SERIALIZES THE UPDATE PATH ONLY — say so plainly, because the obvious
    // reading ("the row is locked, so this is safe") is wrong on the create branch.
    // `FOR UPDATE` locks NOTHING when the row does not exist. Two in-flight FIRST
    // reviews from one user (double-submit, a retry, two tabs) therefore both read
    // `prior = null` and both compute +1; the DB unique lets exactly one INSERT win,
    // and the loser either resolves into an update — applying a second +1, a
    // permanent over-count the ≥0 clamp cannot mask, since it errs high — or fails
    // the constraint and 500s. That is the same class as the mod-hide race, on the
    // branch a row lock cannot reach. It is PRE-EXISTING and deliberately NOT fixed
    // here: closing it means an advisory lock (or an INSERT … ON CONFLICT that
    // returns the pre-image), i.e. a behavioural change to the author write path.
    // The wholesale recompute in #4320 retires this drift class along with the
    // others, which is the better trade than narrowing it twice.
    //
    // Prisma has no `FOR UPDATE` on `findUnique`, hence raw SQL. Identifiers are
    // quoted because `exclude` is a SQL keyword; values are interpolated by the
    // tagged template, so they are bound parameters, not string-concatenated. The
    // template's TEXT is asserted by test — mocked-away SQL is otherwise invisible to
    // CI, and dropping `FOR UPDATE` or a selected column reverts this fix silently.
    //
    // LOCK ORDER — review row, then metric row — is the same in BOTH writers, which
    // is what keeps them deadlock-free against each other. Both transactions run on
    // Prisma's default 5000 ms interactive budget, and these lock waits sit inside
    // it: under real contention this surfaces as a P2028 timeout rather than a queue.
    const priorRows = await tx.$queryRaw<
      Array<{ id: number; recommended: boolean; exclude: boolean }>
    >`
      SELECT "id", "recommended", "exclude"
      FROM "app_listing_reviews"
      WHERE "app_listing_id" = ${appListingId} AND "user_id" = ${userId}
      FOR UPDATE
    `;
    const prior = priorRows[0] ?? null;

    // A prior review contributes to a bucket ONLY when it is non-excluded. The
    // freshly written review keeps the prior `exclude` (create → false); this path
    // never FLIPS `exclude` (that is `setAppListingReviewExclude`'s job), so the
    // AFTER contribution is "the new recommend value, at the prior exclude state".
    // Both sides go through the ONE shared rule so this path and the mod-hide path
    // cannot drift.
    const { upDelta, downDelta } = recommendMetricDelta(
      countedContribution(prior),
      countedContribution({ recommended, exclude: prior?.exclude ?? false })
    );

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

    // Feed the metric in the SAME tx, through the ONE shared writer (a details-only
    // edit computes {0,0} and touches nothing). The two callers of
    // `applyRecommendMetricDelta` are the ONLY writers of thumbsUp/DownCount — see
    // the two-sided contract at the top of this file; the ledger test enforces it.
    await applyRecommendMetricDelta(tx, appListingId, { upDelta, downDelta });

    return { saved, isNewReview: prior == null };
  });

  await bustRecommendMeanCache().catch(() => undefined);
  return { review: review.saved, isNewReview: review.isNewReview };
}

export type SetAppListingReviewExcludeResult = {
  id: number;
  appListingId: string;
  exclude: boolean;
  /**
   * False when the row was ALREADY in the requested state — the no-op transition,
   * in which case nothing at all was written (no row update, no metric delta, no
   * cache bust). Lets the caller distinguish "I hid it" from "it was already hidden"
   * without making the second case an error.
   */
  changed: boolean;
};

/**
 * MODERATOR: hide (or un-hide) a single review — set `AppListingReview.exclude`
 * and move the denormalized recommend counters to match, in ONE transaction.
 *
 * This is the write half of the `exclude` column the schema has carried since the
 * table was created ("Moderator controls: keep abusive reviews out of the
 * recommend-% aggregate"), indexed by `app_listing_reviews_listing_agg_idx`.
 * {@link listAppListingReviews} already filters `exclude`, so hiding takes effect
 * on the visible list with no read-path change.
 *
 * 🔴 SOFT-HIDE, NOT DELETE — three independent reasons, recorded because "just
 * delete the row" is the obvious alternative:
 *   1. `AppListingMetric.thumbsUp/DownCount` is DENORMALIZED with no rollup job,
 *      so a raw delete leaves the displayed "N% recommend (M)" permanently wrong.
 *      Any correct delete has to do this same delta anyway.
 *   2. Removing the row would let the same user file a NEW first review for the
 *      same listing. The sibling app-review reward documents its once-ever
 *      guarantee as "the DB-unique + isFirstReview belt" (the only other guard is a
 *      same-day Redis dedup that expires), and this service already returns
 *      `isNewReview` for exactly that hook — so delete→recreate is a Buzz loop
 *      waiting for the reward to be wired to listings.
 *   3. `exclude` preserves the audit trail (the abusive text stays readable to
 *      moderators) and matches the `tosViolation` sibling flag's semantics.
 *
 * IDEMPOTENT, AND THE IDEMPOTENCE IS SERIALIZED: the transition is expressed as the
 * UPDATE's own predicate (`exclude: { not: exclude }`), so the database decides who
 * transitioned the row, and the delta is applied only by the caller that did. Setting
 * `exclude` to the value the row already holds writes NOTHING and applies a ZERO
 * delta — and so does LOSING a race, which is the case a read-then-branch guard gets
 * wrong. That is what makes a retry, a double-submit, or two moderators working the
 * same report safe under READ COMMITTED; see the comment on the update itself for the
 * mechanism. The delta is {@link recommendMetricDelta}, the SAME function the user
 * write path uses; there is no second copy of the arithmetic.
 *
 * NO STORE-SCOPE THREADING, deliberately: this is `moderatorProcedure`-gated at the
 * router and moderators resolve `full` scope, which admits every listing kind — a
 * scope parameter here could only ever be `full`, and a defaulted one would be an
 * authorization decision (see the note on `upsertAppListingReview`'s `scope`).
 * The trust boundary is the mod gate, and it is the whole boundary.
 *
 * NO `AppListingModerationEvent` is written: that table's `action` column is
 * CHECK-constrained in SQL and a new action value would need a manual-apply
 * migration, which is out of scope here. The `exclude` flag is itself the durable
 * record; wiring an audit event is a follow-up that needs the DDL first.
 */
export async function setAppListingReviewExclude(
  input: SetAppListingReviewExcludeInput
): Promise<SetAppListingReviewExcludeResult> {
  const { reviewId, exclude } = input;

  const result = await dbWrite.$transaction(async (tx) => {
    // 🔴 THE TRANSITION IS THE UPDATE'S OWN PREDICATE — never a read-then-branch.
    //
    // `$transaction` here is Postgres READ COMMITTED (nothing in this codebase sets
    // an `isolationLevel`), which does NOT serialize a read against a concurrent
    // committer. A `findUnique` + `if (row.exclude === exclude)` guard is a
    // read-modify-write: two moderators hiding the same review both read
    // `exclude=false`, both pass the guard, and both apply −1 — permanent counter
    // drift, and the ≥0 clamp only masks it at zero. The same window lets a mod hide
    // race the author's `recommended` flip and decrement the WRONG bucket.
    //
    // A conditional UPDATE closes it with no extra locking primitive: the row lock is
    // taken by the update itself, and under READ COMMITTED Postgres RE-EVALUATES the
    // WHERE against the newly-committed row version after acquiring that lock
    // (EvalPlanQual). So of two racers exactly one sees `count === 1` and the loser
    // sees `count === 0` — the delta is gated on being the winner.
    const { count } = await tx.appListingReview.updateMany({
      where: { id: reviewId, exclude: { not: exclude } },
      data: { exclude },
    });

    // Read AFTER the conditional update, deliberately. When `count === 1` we now hold
    // the row lock, so `recommended` cannot be changed underneath the delta by a
    // concurrent author edit — which is the second half of the race above. (Ordering
    // is pinned by test; reading first would reintroduce it.)
    const row = await tx.appListingReview.findUnique({
      where: { id: reviewId },
      select: { id: true, appListingId: true, recommended: true, exclude: true },
    });
    if (!row) throw throwNotFoundError('Review not found');

    // `count === 0` means WE did not transition the row: it was already in the target
    // state, or a concurrent racer got there first. Both are the same no-op — nothing
    // written, zero delta — and reporting the OBSERVED `row.exclude` rather than the
    // requested target keeps the return honest about what is actually stored.
    if (count === 0) {
      return { id: row.id, appListingId: row.appListingId, exclude: row.exclude, changed: false };
    }

    // BEFORE vs AFTER contribution, through the one shared rule. The BEFORE state is
    // `!exclude` by construction — the conditional matched, so that is what the row
    // held when we locked it. Hiding a recommended review is −1 thumbsUp; hiding a
    // not-recommended one is −1 thumbsDown; un-hiding re-adds the same bucket. The
    // `recommended` value is untouched, so exactly one counter moves by exactly 1.
    await applyRecommendMetricDelta(
      tx,
      row.appListingId,
      recommendMetricDelta(
        countedContribution({ recommended: row.recommended, exclude: !exclude }),
        countedContribution({ recommended: row.recommended, exclude })
      )
    );

    return { id: row.id, appListingId: row.appListingId, exclude, changed: true };
  });

  // Only a real transition shifts the aggregate, so only a real transition needs
  // the store-wide recommend-mean cache busting. Fire-and-forget, as on the write
  // path (a cache-bus outage must never fail a moderation action).
  if (result.changed) await bustRecommendMeanCache().catch(() => undefined);
  return result;
}

/**
 * The caller's OWN review for a listing (form prefill), or null.
 *
 * The STORE-SCOPE kind gate ANDs onto the lookup exactly as it does in
 * {@link listAppListingReviews}: under `public-external` the target listing must
 * ITSELF be offsite, else the relation filter matches nothing → `null`. A viewer
 * must not read back their own review of a listing their scope hides — the row can
 * predate a scope change, so "they wrote it once" is not evidence they may see it
 * now.
 *
 * 🔴 DELIBERATELY DOES NOT FILTER `exclude` — an author still reads back their own
 * mod-hidden review. This is the prefill for the edit form, so hiding the row here
 * would present the form as empty and invite them to file a "new" review that the
 * DB unique turns into an update of the very row they cannot see. Their review is
 * removed from the PUBLIC list and from the aggregate; it is not removed from them.
 * (Pinned by test — it is a behaviour, not an oversight.)
 *
 * 🔴 `findFirst`, not `findUnique`: a relation filter cannot be expressed on a
 * unique-key lookup. The (appListingId, userId) pair is still the DB unique, so at
 * most one row can match and the result is identical whenever the gate passes.
 *
 * 🟡 COST, recorded rather than hidden: `findUnique` participates in Prisma's
 * dataloader batching and `findFirst` does not, so this gives up per-request
 * coalescing on EVERY review-form prefill — including `full` scope, where the added
 * filter is a no-op. One prefill per opened modal, so it is not a hot path, but if
 * this ever moves onto one, the fix is to branch: `findUnique` for `full`,
 * `findFirst` only when the scope actually restricts.
 *
 * 🟡 The `{ is: {} }` / `{ is: { kind: 'offsite' } }` shapes below are asserted only
 * against `dbMock` — no test in this repo exercises real Prisma — so they are pinned
 * as CALL SHAPES, not as queries known to execute. A Prisma upgrade that changed
 * relation-filter syntax would pass these tests and fail in production.
 */
export async function getMyAppListingReview(
  appListingId: string,
  userId: number,
  opts: { scope?: StoreVisibilityScope } = {}
): Promise<MyAppListingReview> {
  const scope = narrowStoreScope(opts.scope);
  const row = await dbRead.appListingReview.findFirst({
    where: {
      appListingId,
      userId,
      appListing: { is: listingKindFilterForScope(scope) },
    },
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
  input: ListAppListingReviewsInput,
  opts: { scope?: StoreVisibilityScope } = {}
): Promise<{ items: AppListingReviewListItem[]; nextCursor?: number }> {
  const take = Math.min(Math.max(input.limit ?? 20, 1), 50);
  // Default `full` for callers that don't pass a scope (the router ALWAYS passes an
  // explicit scope and NEVER calls this with `none` — it short-circuits an empty
  // page at the proc). Under `public-external` the target listing must ITSELF be
  // offsite, else the relation filter matches nothing → empty: a public viewer must
  // not read the reviews of an onsite listing even by a crafted appListingId.
  const scope = narrowStoreScope(opts.scope);
  const rows = await dbRead.appListingReview.findMany({
    where: {
      appListingId: input.appListingId,
      // Only surface reviews for a currently-approved listing: reviews accrue while
      // approved, but a listing can later be removed/rejected — its reviews must not
      // stay publicly enumerable by id once the read flag widens to anon at the P2d
      // cutover. Filtering on the relation also makes a missing listing return empty.
      // The STORE-SCOPE kind gate ANDs onto that relation filter under
      // `public-external` (offsite-only), so an onsite listing's reviews are empty.
      appListing: {
        is: { status: 'approved', ...listingKindFilterForScope(scope) },
      },
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
