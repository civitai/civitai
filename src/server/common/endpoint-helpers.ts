import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server.mjs';

export function TokenSecuredEndpoint(
  token: string,
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.query.token !== token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await handler(req, res);
  };
}

export function JobEndpoint(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>) {
  return TokenSecuredEndpoint(env.JOB_TOKEN, handler);
}

export function WebhookEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>
) {
  return TokenSecuredEndpoint(env.WEBHOOK_TOKEN, handler);
}
