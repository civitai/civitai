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

const PUBLIC_CACHE_MAX_AGE = 60;
const PUBLIC_CACHE_STALE_WHILE_REVALIDATE = 30;

export function PublicEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${PUBLIC_CACHE_MAX_AGE}, stale-while-revalidate=${PUBLIC_CACHE_STALE_WHILE_REVALIDATE}`
    );
    if (req.method === 'OPTIONS') return res.status(200).json({});
    await handler(req, res);
  };
}
