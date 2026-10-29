import type { NextApiRequest, NextApiResponse } from 'next';
import { silenceCheckTypes } from '~/server/notifications/utils.notifications';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Read by the Knights app's notification job (same `x-webhook-token` as its rating write-back) to
// recognise users who turned every notification off. Internal; not part of the public API.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ types: silenceCheckTypes });
});
