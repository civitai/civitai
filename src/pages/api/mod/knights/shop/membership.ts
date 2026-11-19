import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  BuzzMembershipRefusedError,
  grantBuzzPurchaseMembership,
} from '~/server/services/subscriptions.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number().int().positive(),
  tier: z.enum(['bronze', 'silver', 'gold']),
  key: z.string().min(8).max(100),
  // Absent grants a month: Knights builds that predate the week still send none.
  days: z.literal(7).optional(),
});

// Grants a perks-only membership (7 days, or a month when `days` is absent) for gold the Knights shop already reserved, once per `key` (the Knights
// purchase key): a replay is a 200 { outcome: 'already' } whatever the user's membership has become since (the slot keeps its last 20 keys, through Buzz purchases too). A 409 is
// final (active membership, product not available or not monthly), as is a 400 for a body this endpoint never accepts,
// and Knights releases the gold; anything else is retryable with the same key. Rules: `grantBuzzPurchaseMembership`.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { userId, tier, key, days } = parsed.data;

  try {
    const { outcome } = await grantBuzzPurchaseMembership({
      userId,
      tier,
      idempotencyKey: key,
      days,
    });
    return res.status(200).json({ outcome });
  } catch (error) {
    if (error instanceof BuzzMembershipRefusedError) {
      return res.status(409).json({ error: error.message, reason: error.reason });
    }
    throw error;
  }
});
