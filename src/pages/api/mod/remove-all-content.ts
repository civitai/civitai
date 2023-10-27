import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { removeAllContent } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  await removeAllContent({ id: userId });
  const tracker = new Tracker(req, res);
  tracker.userActivity({
    type: 'RemoveContent',
    targetUserId: userId,
  });

  return res.status(200).json({
    userId,
  });
});
