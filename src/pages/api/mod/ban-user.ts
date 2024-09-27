import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { BanReasonCode } from '~/server/common/enums';
import { toggleBan } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  reasonCode: z.nativeEnum(BanReasonCode).optional(),
  detailsExternal: z.string().optional(),
  detailsInternal: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, reasonCode, detailsExternal, detailsInternal } = schema.parse(req.query);

  const user = await toggleBan({
    id: userId,
    reasonCode,
    detailsExternal,
    detailsInternal,
  });

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
