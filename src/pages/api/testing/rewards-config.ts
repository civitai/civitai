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
 * Read-only. It applies the same resolution rules the grant path applies, but
 * reads the row itself from the primary rather than through the grant path's
 * per-pod memo: this is the endpoint an operator reaches for when the panel
 * looks wrong, and a minute-old answer here is the same lie one layer down.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { describeRewards } from '~/server/rewards/describe-rewards';
import {
  configFromStoredValue,
  getStoredRewardConfig,
  MAX_AWARD_AMOUNT,
  MAX_CAP,
  REWARD_CONFIG_KEY,
} from '~/server/rewards/reward-config';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const stored = await getStoredRewardConfig();

  return res.status(200).json({
    key: REWARD_CONFIG_KEY,
    bounds: { awardAmount: [0, MAX_AWARD_AMOUNT], cap: [0, MAX_CAP] },
    rewards: await describeRewards(configFromStoredValue(stored.value)),
  });
});
