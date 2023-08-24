import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { toggleBan } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  const user = await toggleBan({ id: userId });
  const tracker = new Tracker(req, res);
  tracker.userActivity({
    type: user.bannedAt ? 'Banned' : 'Unbanned',
    targetUserId: user.id,
  });

  return res.status(200).json({
    userId,
    username: user.username,
    bannedAt: user.bannedAt,
  });
});
