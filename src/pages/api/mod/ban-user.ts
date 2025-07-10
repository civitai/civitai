import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { Tracker } from '~/server/clickhouse/client';
import { BanReasonCode } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
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

  res.status(200).json({
    userId,
  });

  try {
    const user = await toggleBan({
      id: userId,
      reasonCode,
      detailsExternal,
      detailsInternal,
      userId: -1, // using civitai user for banning using webhook
    });

    const tracker = new Tracker(req, res);
    tracker.userActivity({
      type: user.bannedAt ? 'Banned' : 'Unbanned',
      targetUserId: user.id,
    });
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'mod-ban-user-error',
      error: err.message,
      cause: err.cause,
      stack: err.stack,
    });
  }
});
