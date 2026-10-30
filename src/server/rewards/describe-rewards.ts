import * as rewardImports from '~/server/rewards';
import type { RewardConfig } from '~/server/rewards/reward-config';

/**
 * Every reward described against one config, for the two operator surfaces that
 * answer "which rewards are on, and at what amounts?" — the moderator panel and
 * the debug endpoint. Shared because the endpoint is the thing an operator
 * reaches for when they doubt the panel, so a field added to one view and not the
 * other diverges exactly during the debugging session that compares them.
 *
 * 🔴 Resolves against a config the CALLER read. `resolveRewardConfig` memoises per
 * pod for `CONFIG_TTL_MS`, which is right for the grant path and wrong here: only
 * the pod that served a write clears it, and production runs ~100 pods, so a
 * moderator reading back their own save answers from a stale pod almost every
 * time.
 *
 * Lives outside `reward-config.ts` because it imports the reward definitions,
 * which import `reward-config.ts`.
 */
export async function describeRewards(config: RewardConfig) {
  return (
    await Promise.all(Object.values(rewardImports).map((x) => x.describeConfig(config)))
  ).sort((a, b) => a.type.localeCompare(b.type));
}
