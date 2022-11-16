import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';

export const createContext = async ({
  req,
  res,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
}) => {
  const session = await getServerAuthSession({ req, res });
  return {
    req,
    res,
    user: session?.user,
  };
};

export type Context = AsyncReturnType<typeof createContext>;
