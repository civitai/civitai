import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  return res.status(410).json({
    error: 'This endpoint is no longer available. Contact Dev Support if needed.',
  });
});
