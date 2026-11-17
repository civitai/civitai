import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { NotificationCategory } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';
import { addSystemPermission } from '~/server/services/system-cache';
import { createStripeConnectAccount } from '~/server/services/user-payment-configuration.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  userIds: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json({ error: result.error });
  const { userIds } = result.data;

  await Promise.all(
    userIds.map(async (userId) => {
      await createStripeConnectAccount({ userId });

      await createNotification({
        userId,
        type: 'creators-program-enabled',
        category: NotificationCategory.System,
        key: `creators-program-enabled:${userId}`,
        details: {},
      }).catch();
    })
  );

  await addSystemPermission('creatorsProgram', userIds);

  return res.status(200).json({
    success: true,
  });
});
