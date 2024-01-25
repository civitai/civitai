import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import {
  createUserStripeConnectAccount,
  payToStripeConnectAccount,
} from '../../../server/services/user-stripe-connect.service';
import { createNotification } from '../../../server/services/notification.service';
import { getServerAuthSession } from '../../../server/utils/get-server-auth-session';

const schema = z.object({
  userId: z.coerce.number(),
  amount: z.coerce.number(),
});

export default ModEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, amount } = schema.parse(req.query);
  const session = await getServerAuthSession({ req, res });

  if (!session?.user) {
    return res.status(401).json({
      success: false,
    });
  }

  await payToStripeConnectAccount({
    toUserId: userId,
    amount,
    description: 'Payment from Mod',
    byUserId: session?.user.id,
  });

  return res.status(200).json({
    success: true,
  });
});
