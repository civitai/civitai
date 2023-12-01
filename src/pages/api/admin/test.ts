import { NextApiRequest, NextApiResponse } from 'next';
import { eventEngine } from '~/server/events';

export default async function (req: NextApiRequest, res: NextApiResponse) {
  await eventEngine.processEngagement({
    userId: 1,
    type: 'published',
    entityType: 'model',
    entityId: 7,
  });

  return res.status(200).json({
    ok: true,
  });
}
