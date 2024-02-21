import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server.mjs';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { Tracker } from './clickhouse/client';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { parseBrowsingMode } from '~/server/utils/server-side-helpers';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

type CacheSettings = {
  browserTTL?: number;
  edgeTTL?: number;
  staleWhileRevalidate?: number;
  tags?: string[];
  canCache?: boolean;
  skip: boolean;
};

const origins = [env.NEXTAUTH_URL, ...(env.TRPC_ORIGINS ?? [])];
export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  const ip = requestIp.getClientIp(req) ?? '';
  const acceptableOrigin = isProd
    ? origins.some((o) => req.headers.referer?.startsWith(o)) ?? false
    : true;
  const { browsingLevel, showNsfw } = parseBrowsingMode(req.cookies, session);
  const track = new Tracker(req, res);
  const cache: CacheSettings | null = {
    browserTTL: session?.user ? 0 : 60,
    edgeTTL: session?.user ? 0 : 60,
    staleWhileRevalidate: session?.user ? 0 : 30,
    canCache: true,
    skip: false,
  };

  return {
    user: session?.user,
    browsingLevel,
    showNsfw,
    acceptableOrigin,
    track,
    ip,
    cache,
    res,
    req,
  };
};

export const publicApiContext = (req: NextApiRequest, res: NextApiResponse) => ({
  user: undefined,
  acceptableOrigin: true,
  browsingLevel: publicBrowsingLevelsFlag,
  showNsfw: false,
  track: new Tracker(req, res),
  ip: requestIp.getClientIp(req) ?? '',
  cache: {
    browserCacheTTL: 3 * 60,
    edgeCacheTTL: 3 * 60,
    staleWhileRevalidate: 60,
    canCache: true,
    skip: false,
  },
  res,
  req,
});

export type Context = AsyncReturnType<typeof createContext>;
