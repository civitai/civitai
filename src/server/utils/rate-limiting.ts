import { NextApiRequest, NextApiResponse } from 'next';
import { handleMaintenanceMode } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import requestIp from 'request-ip';
import { redisLegacy } from '~/server/redis/client';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { env } from '~/env/server.mjs';

const limiterOptions = {
  points: 30, // allow points
  duration: 60, // per second
};
const unauthedPointCost = 6;
const rateLimiter = new RateLimiterRedis({
  storeClient: redisLegacy,
  keyPrefix: 'rate-limiter',
  inMemoryBlockOnConsumed: limiterOptions.points,
  ...limiterOptions,
});

const isRateLimited = async (req: NextApiRequest, res: NextApiResponse, resourceKey = 'base') => {
  if (!env.RATE_LIMITING) return false;

  const session = await getServerAuthSession({ req, res });
  const requesterKey = session?.user?.id ?? requestIp.getClientIp(req);
  const pointCost = !!session?.user ? 1 : unauthedPointCost;

  res.setHeader('X-RateLimit-Limit', Math.floor(limiterOptions.points / pointCost));
  try {
    const rateLimiterRes = await rateLimiter.consume(`${resourceKey}:${requesterKey}`, pointCost);
    res.setHeader('X-RateLimit-Remaining', Math.floor(rateLimiterRes.remainingPoints / pointCost));
  } catch (e: any) {
    if (e instanceof Error) {
      // Some redis error
      console.error(e);
      return false;
    }

    const secs = Math.ceil(e.msBeforeNext / 1000) || 1;
    res.setHeader('Retry-After', String(secs));
    res.setHeader('X-RateLimit-Remaining', 0);
    res.status(429).json({ error: 'Too Many Requests' });

    return true;
  }

  return false;
};

export const RateLimitedEndpoint =
  (
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse<any>>,
    allowedMethods: string[] = ['GET'],
    resourceKey = 'base'
  ) =>
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (handleMaintenanceMode(req, res)) return;

    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (await isRateLimited(req, res, resourceKey)) return;

    await handler(req, res);
  };
