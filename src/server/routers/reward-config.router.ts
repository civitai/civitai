import { describeRewards } from '~/server/rewards/describe-rewards';
import {
  configFromStoredValue,
  getStoredRewardConfig,
  setRewardConfig,
  setRewardConfigSchema,
  storedViewOf,
} from '~/server/rewards/reward-config';
import { moderatorProcedure, router } from '~/server/trpc';

export const rewardConfigRouter = router({
  // `stored` is the row as written — raw, and flagged when it would not survive
  // `set`, so an editor can refuse to save over a row it cannot faithfully show.
  // `rewards` is what the grant path would resolve from that same row, including
  // refused fields — resolved from the row this call just read rather than from
  // the memo, so one primary read answers both halves and they cannot disagree.
  get: moderatorProcedure.query(async () => {
    const stored = await getStoredRewardConfig();
    return { stored, rewards: await describeRewards(configFromStoredValue(stored.value)) };
  }),
  // The input schema is what keeps the middleware's `browsingLevel` out of a row
  // `set` replaces wholesale — zod strips unknown keys, and the router test
  // asserts the service is called with the row alone.
  //
  // 🔴 Returns the same shape as `get`, resolved from the value just WRITTEN, so
  // the caller never has to read its own write back. Re-reading here instead
  // would reach `dbRead` — the replica — and hand back the pre-write row under
  // lag, which is this bug again with a fresh cause.
  set: moderatorProcedure.input(setRewardConfigSchema).mutation(async ({ input, ctx }) => {
    const value = await setRewardConfig({ rewards: input.rewards }, ctx.user.id, {
      expectedHash: input.expectedHash,
      force: input.force,
    });

    return {
      stored: storedViewOf(value),
      rewards: await describeRewards(configFromStoredValue(value)),
    };
  }),
});
