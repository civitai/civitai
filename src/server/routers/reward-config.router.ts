import * as rewardImports from '~/server/rewards';
import {
  getStoredRewardConfig,
  rewardConfigSchema,
  setRewardConfig,
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
  set: moderatorProcedure.input(rewardConfigSchema).mutation(({ input }) => setRewardConfig(input)),
});
