import { createBuzzEvent } from '../base.reward';

/**
 * Blue-buzz reward for leaving an App Block review (F-E "marketplace" cluster).
 *
 * Fires ONCE per (user, app): `forId = appBlockId` is the dedup anchor, and the
 * caller only `apply`s on the CREATE branch of the review upsert (the DB unique
 * `(app_block_id, user_id)` guarantees there's exactly one create per pair). The
 * on-demand Redis dedup (`type:forId:toUserId:byUserId`) is a second belt.
 *
 * Blue buzz (non-cashable, generation-only) is the right currency: a review
 * reward should fund generation, never be withdrawable. cap == awardAmount so a
 * user can earn it at most once per app per day-window (the per-(user,app)
 * uniqueness already caps it at once ever — the cap is belt-and-suspenders).
 *
 * Fail-soft: the inline `apply` path in createBuzzEvent never rethrows (a
 * ClickHouse/reward brownout must not 500 the review write). The caller still
 * wraps it in try/catch for defense-in-depth.
 */
export const appBlockReviewReward = createBuzzEvent({
  type: 'appBlockReview',
  toAccountType: 'blue',
  description: 'You left a review on an app',
  triggerDescription: 'For the first review you leave on each app',
  awardAmount: 25,
  cap: 25,
  onDemand: true,
  getKey: async (input: AppBlockReviewEvent) => {
    // Only the first review (the create branch) is rewardable. A no-op update
    // passes isFirstReview=false → no key → no award.
    if (!input.isFirstReview) return false;
    return {
      toUserId: input.userId,
      forId: input.appBlockId, // per-(user,app) dedup
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
