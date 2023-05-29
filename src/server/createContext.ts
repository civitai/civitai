import { NextApiRequest, NextApiResponse } from 'next';
import { Session } from 'next-auth';
import { env } from '~/env/server.mjs';
import { parseFilterCookies } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { Tracker } from './clickhouse/client';

export const parseBrowsingMode = (
  cookies: Partial<{ [key: string]: string }>,
  session: Session | null
) => {
  if (!session?.user?.showNsfw) return BrowsingMode.SFW;
  const browsingMode = parseFilterCookies(cookies).browsingMode;
  return browsingMode; // NSFW = "My Filters" and should be the default if a user is logged in
};

type CacheSettings = {
  browserTTL?: number;
  edgeTTL?: number;
  staleWhileRevalidate?: number;
  tags?: string[];
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
  const acceptableOrigin = origins.some((o) => req.headers.referer?.startsWith(o)) ?? false;
  const browsingMode = parseBrowsingMode(req.cookies, session);
  const track = new Tracker(req, res);
  const cache: CacheSettings | null = {
    browserTTL: session?.user ? 0 : 60,
    edgeTTL: session?.user ? 0 : 60,
    staleWhileRevalidate: session?.user ? 0 : 30,
  };

  return {
    user: session?.user,
    browsingMode,
    acceptableOrigin,
    track,
    cache,
    res,
  };
};

export const publicApiContext = (req: NextApiRequest, res: NextApiResponse) => ({
  user: undefined,
  acceptableOrigin: true,
  browsingMode: BrowsingMode.All,
  track: new Tracker(req, res),
  cache: {
    browserCacheTTL: 3 * 60,
    edgeCacheTTL: 3 * 60,
    staleWhileRevalidate: 60,
  },
  res,
});

export type Context = AsyncReturnType<typeof createContext>;
