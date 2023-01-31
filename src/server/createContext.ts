import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server.mjs';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  const acceptableOrigin = req.headers.referer?.startsWith(env.NEXTAUTH_URL) ?? false;
  return {
    user: session?.user,
    acceptableOrigin,
  };
};

export const publicApiContext = {
  user: undefined,
  acceptableOrigin: true,
};

export type Context = AsyncReturnType<typeof createContext>;
