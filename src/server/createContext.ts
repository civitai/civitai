import { NextApiRequest, NextApiResponse } from 'next';
import { Session } from 'next-auth';
import { env } from '~/env/server.mjs';
import { parseFiltersCookie } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export const parseBrowsingMode = (
  cookies: Partial<{ [key: string]: string }>,
  session: Session | null
) => {
  if (!session) return BrowsingMode.SFW;
  if (!session.user?.showNsfw) return BrowsingMode.SFW;
  const browsingMode = parseFiltersCookie(cookies)?.browsingMode;
  return browsingMode ?? BrowsingMode.NSFW; // NSFW = "My Filters" and should be the default if a user is authed
};

export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  const acceptableOrigin = req.headers.referer?.startsWith(env.NEXTAUTH_URL) ?? false;
  const browsingMode = parseBrowsingMode(req.cookies, session);

  return {
    user: session?.user,
    browsingMode,
    acceptableOrigin,
  };
};

export const publicApiContext = {
  user: undefined,
  acceptableOrigin: true,
  browsingMode: BrowsingMode.All,
};

export type Context = AsyncReturnType<typeof createContext>;
