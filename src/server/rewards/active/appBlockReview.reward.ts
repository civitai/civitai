import { createBuzzEvent } from '../base.reward';

// Per-review award (blue buzz). The feature is "earn buzz for leaving a review",
// so EACH distinct app the user first-reviews pays this once.
const REVIEW_AWARD = 25;

// DAILY ANTI-ABUSE CEILING (tunable). The on-demand reward's Lua cap counts ALL
// entries in the per-(user, type) daily hash, so `cap` is a TOTAL across every
// distinct app reviewed today — NOT a per-app cap. We set it to N distinct
// app-reviews/day so each new app pays, while a single user can't farm it
// unbounded in one UTC day. Blue buzz is non-cashable (generation-only) and
// reviews are install-gated, so the farm value is low; pick a generous N.
//   ⚠️ If this were `cap == REVIEW_AWARD`, the user's FIRST paid review on a UTC
//   day would exhaust the cap and every OTHER distinct-app first-review that day
//   would be capped to 0 — defeating the per-distinct-app intent.
const DAILY_REVIEW_REWARD_CEILING = REVIEW_AWARD * 10; // 10 app-reviews/day

/**
 * Blue-buzz reward for leaving an App Block review (F-E "marketplace" cluster).
 *
 * ONCE EVER PER (user, app) — guaranteed by two existing belts (NOT this cap):
 *   1. DB-side: the `AppBlockReview` unique `(app_block_id, user_id)` + the
 *      service's `isFirstReview` (true ONLY on the create branch) ⇒ the reward
 *      is `apply`d at most once per (user, app), ever.
 *   2. Redis-side: the on-demand dedup keys on `forId = appBlockId`, so the SAME
 *      app reviewed twice the same UTC day hashes to the SAME cacheKey and is
 *      deduped (returns -1). DISTINCT apps hash to DISTINCT cacheKeys, so they
 *      do NOT dedup against each other — each distinct app can pay.
 *
 * `cap` is therefore a DAILY ANTI-FARM CEILING across all apps (see
 * DAILY_REVIEW_REWARD_CEILING), NOT the once-per guard. Raising it lets distinct
 * apps each pay (up to the ceiling/award per UTC day) WITHOUT letting the same
 * app pay twice — the two belts above own that.
 *
 * Blue buzz (non-cashable, generation-only) is the right currency: a review
 * reward should fund generation, never be withdrawable.
 *
 * Fail-soft: the inline `apply` path in createBuzzEvent never rethrows (a
 * ClickHouse/reward brownout must not 500 the review write). The caller still
 * wraps it in try/catch for defense-in-depth.
 */
export const appBlockReviewReward = createBuzzEvent({
  type: 'appBlockReview',
  toAccountType: 'blue',
  description: 'You left a review on an app',
  triggerDescription: 'For each app you review for the first time',
  awardAmount: REVIEW_AWARD,
  // Daily ceiling, NOT a per-app cap. The per-(user, app) once-ever guarantee is
  // the DB-unique + isFirstReview belt; same-app same-day is the Redis forId
  // dedup. This only bounds total distinct-app review rewards per UTC day.
  cap: DAILY_REVIEW_REWARD_CEILING,
  onDemand: true,
  getKey: async (input: AppBlockReviewEvent) => {
    // Only the first review (the create branch) is rewardable. A no-op update
    // passes isFirstReview=false → no key → no award.
    if (!input.isFirstReview) return false;
    return {
      toUserId: input.userId,
      // DISTINCT per app: this is the Redis dedup anchor, so distinct apps get
      // distinct cacheKeys (each pays) while the same app same-day is deduped.
      forId: input.appBlockId,
      byUserId: input.userId,
      type: `appBlockReview`,
    };
  },
});

type AppBlockReviewEvent = {
  appBlockId: string;
  userId: number;
  isFirstReview: boolean;
};
