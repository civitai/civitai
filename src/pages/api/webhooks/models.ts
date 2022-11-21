import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { appRouter } from '~/server/routers';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { QS } from '~/utils/qs';

const getModelsInputSchema = getAllModelsSchema
  .extend({
    limit: z.preprocess((val) => Number(val), z.number().min(1).max(200)),
    cursor: z.preprocess((val) => Number(val), z.number()),
    page: z.preprocess((val) => Number(val), z.number()),
  })
  .partial();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  switch (method) {
    case 'GET': {
      const queryParams = getModelsInputSchema.safeParse(req.query);
      if (!queryParams.success)
        return res.status(400).send(`Bad data! ${queryParams.error.message}`);

      const apiCaller = appRouter.createCaller({ user: undefined });

      const { nextCursor, items } = await apiCaller.model.getAll(queryParams.data);
      let nextPage: string | null = null;
      if (nextCursor) {
        const nextPageQueryString = QS.stringify({ ...queryParams.data, cursor: nextCursor });
        const baseUrl = new URL(
          req.url ?? '/',
          env.NODE_ENV === 'production' ? `https://${req.headers.host}` : 'http://localhost:3000'
        );
        nextPage = `${baseUrl.origin}${baseUrl.pathname}?${nextPageQueryString}`;
      }

      res.status(200).json({
        items,
        metadata: { nextPage },
      });
      break;
    }

    default: {
      res.setHeader('Allow', ['GET']);
      res.status(405).end(`Method ${method} not allowed`);
      break;
    }
  }
}
