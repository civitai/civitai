import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { ModEndpoint, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createUserStripeConnectAccount } from '../../../server/services/user-stripe-connect.service';
import { createNotification } from '../../../server/services/notification.service';
import { addSystemPermission } from '../../../server/services/system-cache';
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
      await createUserStripeConnectAccount({ userId });

      await createNotification({
        userId,
        type: 'creators-program-enabled',
        category: 'System',
      }).catch();
    })
  );

  await addSystemPermission('creatorsProgram', userIds);

  return res.status(200).json({
    success: true,
  });
});
