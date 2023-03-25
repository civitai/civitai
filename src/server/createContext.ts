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
  const defaultValue = session ? BrowsingMode.NSFW : BrowsingMode.SFW;
  if (!session) return defaultValue;
  const browsingMode = parseFiltersCookie(cookies)?.browsingMode;
  return browsingMode ?? defaultValue;
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
