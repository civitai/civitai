import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { notifications } from '~/server/notifications/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  before: z.coerce.date(),
});

// Deletes UserNotification rows older than `before`. The batched, cancellable delete now lives in the
// notifications app (apps/notifications) behind cleanupNotifications — this endpoint just triggers it.
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { before } = schema.parse(req.query);

  const start = Date.now();
  const { deleted } = await notifications.cleanupNotifications({ before });

  return res.status(200).json({
    ok: true,
    deleted,
    duration: (Date.now() - start) / 1000,
  });
});
