import { TRPCError } from '@trpc/server';
import { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = appRouter.createCaller(publicApiContext(req, res));

  try {
    const result = await apiCaller.content.get({ slug: req.query.slug });
    return res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof TRPCError) return res.status(500).json({ error: error.cause });
    else return res.status(500).json({ error: 'Internal server error' });
  }
});
