import { NextApiRequest, NextApiResponse } from 'next';
import { eventEngine } from '~/server/events';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  await eventEngine.processEngagement({
    entityType: 'model',
    type: 'published',
    entityId: 218322,
    userId: 969069,
  });

  return res.status(200).json({
    ok: true,
  });
});
