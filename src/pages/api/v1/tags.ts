import { TagTarget } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext } from '~/server/createContext';

import { appRouter } from '~/server/routers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = appRouter.createCaller(publicApiContext(req, res));
  try {
    const { items, ...metadata } = await apiCaller.tag.getAll({
      ...req.query,
      withModels: true,
      entityType: [TagTarget.Model],
    });
    const { nextPage, prevPage, baseUrl } = getPaginationLinks({
      ...metadata,
      req,
    });

    res.status(200).json({
      items:
        items?.map(({ models = [], name }) => ({
          name,
          modelCount: models.length ? models.length : undefined,
          link: `${baseUrl.origin}/api/v1/models?tag=${name}`,
        })) ?? [],
      metadata: {
        ...metadata,
        nextPage,
        prevPage,
      },
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
