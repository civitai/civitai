import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { publicApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { getAllUsersInput } from '~/server/schema/user.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = getAllUsersInput.extend({
  email: z.never().optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = appRouter.createCaller(publicApiContext(req, res));
  const isSystemRequest = req.query.token === env.WEBHOOK_TOKEN;
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const query = result.data;
  const limit = query.ids?.length ?? 5;
  const include = isSystemRequest ? query.include : [];
  try {
    const users = await apiCaller.user.getAll({ ...query, limit, include });

    return res.status(200).json({
      items: users ?? [],
    });
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      const parsedError = JSON.parse(error.message);

      res.status(status).json(parsedError);
    } else {
      const err = error as Error;
      res.status(500).json({ message: 'An unexpected error occurred', error: err.message });
    }
  }
});
