import * as rewardImports from '~/server/rewards';
import {
  getStoredRewardConfig,
  setRewardConfig,
  setRewardConfigSchema,
} from '~/server/rewards/reward-config';
import { moderatorProcedure, router } from '~/server/trpc';

export const rewardConfigRouter = router({
  // `stored` is the row as written — raw, and flagged when it would not survive
  // `set`, so an editor can refuse to save over a row it cannot faithfully show.
  // `rewards` is what the grant path actually resolved, including refused fields.
  get: moderatorProcedure.query(async () => ({
    stored: await getStoredRewardConfig(),
    rewards: (await Promise.all(Object.values(rewardImports).map((x) => x.describeConfig()))).sort(
      (a, b) => a.type.localeCompare(b.type)
    ),
  })),
  // The input schema is what keeps the middleware's `browsingLevel` out of a row
  // `set` replaces wholesale — zod strips unknown keys, and the router test
  // asserts the service is called with the row alone.
  set: moderatorProcedure.input(setRewardConfigSchema).mutation(({ input, ctx }) =>
    setRewardConfig({ rewards: input.rewards }, ctx.user.id, {
      expectedHash: input.expectedHash,
      force: input.force,
    })
  ),
});
