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
    page: z.never(),
    rating: z.never(),
  })
  .partial();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  switch (method) {
    case 'GET': {
      const queryParams = getModelsInputSchema.safeParse(req.query);
      if (!queryParams.success)
        return res.status(400).json({
          message: 'Invalid query parameters',
          error: queryParams.error.flatten().fieldErrors,
        });

      const apiCaller = appRouter.createCaller({ user: undefined });
      const { nextCursor, items } = await apiCaller.model.getAllWithVersions(queryParams.data);

      const baseUrl = new URL(
        req.url ?? '/',
        env.NODE_ENV === 'production' ? `https://${req.headers.host}` : 'http://localhost:3000'
      );

      let nextPage: string | null = null;
      if (nextCursor) {
        const nextPageQueryString = QS.stringify({ ...queryParams.data, cursor: nextCursor });
        nextPage = `${baseUrl.origin}${baseUrl.pathname}?${nextPageQueryString}`;
      }

      res.status(200).json({
        items: items.map(({ modelVersions, ...model }) => ({
          ...model,
          modelVersions: modelVersions.map((version) => ({
            ...version,
            downloadUrl: `${baseUrl.origin}/api/download/models/${version.id}`,
          })),
        })),
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
