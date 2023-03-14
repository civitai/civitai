import { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const handler = WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  return res.status(200).json({
    headers: req.headers,
  });
});

export default handler;
