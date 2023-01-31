import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { publicApiContext } from '~/server/createContext';

import { appRouter } from '~/server/routers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ query: z.string().optional() });

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = appRouter.createCaller(publicApiContext);
  try {
    const query = await schema.parseAsync(req.query);
    const users = await apiCaller.user.getAll({ ...query, limit: 5 });

    return res.status(200).json({
      items:
        users?.map(({ id, username }) => ({
          id,
          username,
        })) ?? [],
    });
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      const parsedError = JSON.parse(error.message);

      res.status(status).json(parsedError);
    } else {
      res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  }
});
