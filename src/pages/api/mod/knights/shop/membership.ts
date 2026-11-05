import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { grantMembershipMonths, MembershipGrantRefused } from '~/server/services/referral.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number().int().positive(),
  tier: z.enum(['bronze', 'silver', 'gold']),
  months: z.coerce.number().int().min(1).max(12),
  key: z.string().min(8).max(100),
});

// Grants Knights gold-shop membership months, once per `key` (the Knights purchase key): a replay is a 200
// { outcome: 'already' }. A 409 is final (queue full, tier not configured) and the caller releases the gold;
// anything else is retryable with the same key. Stacking rules: see `grantMembershipMonths`.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  try {
    const { outcome } = await grantMembershipMonths(parsed.data);
    return res.status(200).json({ outcome });
  } catch (error) {
    if (error instanceof MembershipGrantRefused) {
      return res.status(409).json({ error: error.message, reason: error.reason });
    }
    throw error;
  }
});
