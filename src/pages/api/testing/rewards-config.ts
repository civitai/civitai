/**
 * Debug endpoint for runtime reward configuration.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   GET /api/testing/rewards-config?token=$WEBHOOK_TOKEN
 *
 * Answers "which rewards are on, and at what amounts?" from one place, so an
 * operator does not have to read the `rewards:config` KeyValue row and the
 * reward definitions and reconcile them by hand. Each row reports the compiled
 * default beside the effective value, and — the part a raw row read cannot show
 * — any override field that was refused for being out of bounds or the wrong
 * type.
 *
 * Read-only. It resolves through the same `resolveRewardConfig` the grant path
 * uses, including its cache, so a change written in the last minute may not
 * appear yet.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as rewardImports from '~/server/rewards';
import { MAX_AWARD_AMOUNT, MAX_CAP, REWARD_CONFIG_KEY } from '~/server/rewards/reward-config';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const rewards = await Promise.all(Object.values(rewardImports).map((x) => x.describeConfig()));

  return res.status(200).json({
    key: REWARD_CONFIG_KEY,
    bounds: { awardAmount: [0, MAX_AWARD_AMOUNT], cap: [0, MAX_CAP] },
    rewards: rewards.sort((a, b) => a.type.localeCompare(b.type)),
  });
});
