import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { getUserSubscription } from '~/server/services/subscriptions.service';
import { env } from '~/env/server';
import type { UserTier } from '~/server/schema/user.schema';

const schema = z.object({
  userId: z.string().transform((val) => parseInt(val, 10)),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed. Use POST.');

  const result = schema.safeParse(req.query);

  if (!result.success) {
    return res.status(400).json({ error: 'Invalid userId parameter' });
  }

  const { userId } = result.data;

  try {
    const targetUser = await dbRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        bannedAt: true,
        muted: true,
      },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscription = await getUserSubscription({ userId });
    const tier: UserTier | undefined =
      subscription && ['active', 'trialing'].includes(subscription.status)
        ? ((subscription.product.metadata as Record<string, unknown>)[
            env.TIER_METADATA_KEY
          ] as UserTier)
        : undefined;

    res.json({
      id: targetUser.id,
      username: targetUser.username,
      tier,
      status: targetUser.bannedAt ? 'banned' : targetUser.muted ? 'muted' : 'active',
      isMember: tier ? tier !== 'free' : false,
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
