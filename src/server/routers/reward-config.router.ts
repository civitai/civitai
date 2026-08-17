import * as rewardImports from '~/server/rewards';
import {
  getStoredRewardConfig,
  rewardConfigSchema,
  setRewardConfig,
} from '~/server/rewards/reward-config';
import { moderatorProcedure, router } from '~/server/trpc';

export const rewardConfigRouter = router({
  // `stored` is the row as written, for the editor's inputs; `rewards` is what
  // the grant path actually resolved, including any field it refused.
  get: moderatorProcedure.query(async () => ({
    stored: await getStoredRewardConfig(),
    rewards: (await Promise.all(Object.values(rewardImports).map((x) => x.describeConfig()))).sort(
      (a, b) => a.type.localeCompare(b.type)
    ),
  })),
  set: moderatorProcedure.input(rewardConfigSchema).mutation(({ input }) => setRewardConfig(input)),
});
