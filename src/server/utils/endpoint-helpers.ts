import { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '~/server/db/client';
import { env } from '~/env/server.mjs';
import { Partner } from '@prisma/client';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generateSecretHash } from '~/server/utils/key-generator';
import { isMaintenanceMode } from '~/env/other';
import { Session } from 'next-auth';

function handleMaintenanceMode(req: NextApiRequest, res: NextApiResponse) {
  if (isMaintenanceMode) {
    res.status(503);
    if (req.headers['content-type'] == 'application/json')
      res.json({ error: `We're performing maintenance check back soon` });
    else res.redirect('/');
    return true;
  }

  return false;
}

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

const PUBLIC_CACHE_MAX_AGE = 300;
const PUBLIC_CACHE_STALE_WHILE_REVALIDATE = PUBLIC_CACHE_MAX_AGE / 2;

export function PublicEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (handleMaintenanceMode(req, res)) return;

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

export function AuthedEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse, user: Session['user']) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (handleMaintenanceMode(req, res)) return;

    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });

    const session = await getServerAuthSession({ req, res });
    if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });
    await handler(req, res, session.user);
  };
}

export function PartnerEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse, partner: Partner) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (handleMaintenanceMode(req, res)) return;

    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (!req.query.token || Array.isArray(req.query.token))
      return res.status(401).json({ error: 'Unauthorized' });
    const token = generateSecretHash(req.query.token);
    const partner = await prisma.partner.findUnique({ where: { token } });
    if (!partner) return res.status(401).json({ error: 'Unauthorized', message: 'Bad token' });

    await handler(req, res, partner);
  };
}

export function ModEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    const session = await getServerAuthSession({ req, res });
    const { isModerator, bannedAt } = session?.user ?? {};
    if (!isModerator || bannedAt) return res.status(401).json({ error: 'Unauthorized' });

    await handler(req, res);
  };
}
