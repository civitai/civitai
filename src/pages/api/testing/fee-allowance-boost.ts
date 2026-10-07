/**
 * Loads the licensing-fee allowance boost grant list.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   POST /api/testing/fee-allowance-boost?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   grant   - {userIds, amount?}  Grant `amount` (default and max FEE_ALLOWANCE_BOOST_MAX) extra
 *                                 licensing-fee slots to each user without a grant. Load the ids from a
 *                                 file. An existing grant is left as is; revoke it first to change it.
 *   get     - {userId}            The stored grant and the boost it resolves to right now
 *   revoke  - {userId}            Remove one user's grant
 *   count   - {}                  How many users hold a grant
 *
 * The boost stops applying at FEE_ALLOWANCE_BOOST_ENDS_AT whatever this list holds; the key's Redis
 * expiry is set to the same instant only so the list does not linger.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  FEE_ALLOWANCE_BOOST_ENDS_AT,
  FEE_ALLOWANCE_BOOST_MAX,
  feeAllowanceBoost,
} from '@civitai/buzz';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const KEY = REDIS_SYS_KEYS.PRICING.FEE_ALLOWANCE_BOOST;
const userId = z.coerce.number().int().positive();

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    userIds: z.array(userId).min(1).max(5000),
    amount: z.coerce
      .number()
      .int()
      .min(1)
      .max(FEE_ALLOWANCE_BOOST_MAX)
      .default(FEE_ALLOWANCE_BOOST_MAX),
  }),
  z.object({ action: z.literal('get'), userId }),
  z.object({ action: z.literal('revoke'), userId }),
  z.object({ action: z.literal('count') }),
]);

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  switch (input.action) {
    case 'grant': {
      if (new Date() >= FEE_ALLOWANCE_BOOST_ENDS_AT)
        return res.status(400).json({ error: 'The boost window has closed.' });
      const ids = [...new Set(input.userIds)];
      const added = await Promise.all(
        ids.map((id) => sysRedis.hSetNX(KEY, String(id), String(input.amount)))
      );
      await sysRedis.expireAt(KEY, FEE_ALLOWANCE_BOOST_ENDS_AT);
      const granted = added.filter(Boolean).length;
      return res.status(200).json({
        granted,
        alreadyGranted: ids.length - granted,
        amount: input.amount,
        endsAt: FEE_ALLOWANCE_BOOST_ENDS_AT,
      });
    }
    case 'get': {
      const stored = await sysRedis.hGet<string>(KEY, String(input.userId));
      return res.status(200).json({ stored, boost: feeAllowanceBoost(stored) });
    }
    case 'revoke': {
      const removed = await sysRedis.hDel(KEY, String(input.userId));
      return res.status(200).json({ removed });
    }
    case 'count': {
      const all = await sysRedis.hGetAll(KEY);
      return res.status(200).json({ count: Object.keys(all).length });
    }
  }
});
