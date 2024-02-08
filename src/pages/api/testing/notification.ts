import { NextApiRequest, NextApiResponse } from 'next';
import { createNotification } from '~/server/services/notification.service';

export default async function snedTipNotification(req: NextApiRequest, res: NextApiResponse) {
  await createNotification({
    type: 'tip-received',
    userId: 4,
    details: {
      amount: 1234,
      user: 'lrojas',
      fromUserId: 18085,
      message: 'testing',
    },
  });

  await createNotification({
    type: 'model-like-milestone',
    userId: 4,
    details: {
      modelName: 'Test 1',
      modelId: 267350,
      favoriteCount: 18085,
    },
  });

  return res.status(200).send('ok');
}
