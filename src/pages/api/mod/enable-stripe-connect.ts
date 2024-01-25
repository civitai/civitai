import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { createUserStripeConnectAccount } from '../../../server/services/user-stripe-connect.service';
import { createNotification } from '../../../server/services/notification.service';

const schema = z.object({
  userId: z.coerce.number(),
});

export default ModEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);
  await createUserStripeConnectAccount({ userId });

  await createNotification({
    userId,
    type: 'creators-program-enabled',
  }).catch();

  return res.status(200).json({
    success: true,
  });
});
