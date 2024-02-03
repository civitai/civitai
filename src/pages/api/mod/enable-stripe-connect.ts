import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { ModEndpoint, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createUserStripeConnectAccount } from '../../../server/services/user-stripe-connect.service';
import { createNotification } from '../../../server/services/notification.service';
import { addSystemPermission } from '../../../server/services/system-cache';

const schema = z.object({
  userIds: z.preprocess((val) => (Array.isArray(val) ? val : [val]), z.array(z.coerce.number())),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userIds } = schema.parse(req.query);

  await Promise.all(
    userIds.map(async (userId) => {
      await createUserStripeConnectAccount({ userId });
      await addSystemPermission('creatorsProgram', [userId]);

      await createNotification({
        userId,
        type: 'creators-program-enabled',
      }).catch();
    })
  );

  await addSystemPermission('creatorsProgram', userIds);

  return res.status(200).json({
    success: true,
  });
});
