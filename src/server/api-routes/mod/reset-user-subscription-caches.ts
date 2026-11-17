import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  await invalidateSubscriptionCaches(userId);

  res.status(200).json({
    userId,
  });
});
