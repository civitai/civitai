import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';

import { appRouter } from '~/server/routers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  switch (method) {
    case 'GET': {
      const apiCaller = appRouter.createCaller({ user: undefined });
      try {
        const { items, ...metadata } = await apiCaller.model.getAllWithVersions(req.query);
        const { nextPage, prevPage, baseUrl } = getPaginationLinks({ ...metadata, req });

        res.status(200).json({
          items: items.map(({ modelVersions, tagsOnModels, ...model }) => ({
            ...model,
            tags: tagsOnModels.map(({ tag }) => tag.name),
            modelVersions: modelVersions.map(({ images, ...version }) => ({
              ...version,
              images: images.map(({ image: { url, ...image } }) => ({
                url: getEdgeUrl(url, { width: 450 }),
                ...image,
              })),
              downloadUrl: `${baseUrl.origin}/api/download/models/${version.id}`,
            })),
          })),
          metadata: { ...metadata, nextPage, prevPage },
        });
      } catch (error) {
        if (error instanceof TRPCError) {
          const apiError = error as TRPCError;
          const status = getHTTPStatusCodeFromError(apiError);
          const parsedError = JSON.parse(apiError.message);

          res.status(status).json(parsedError);
        } else {
          res.status(500).json({ message: 'An unexpected error occurred', error });
        }
      }

      break;
    }

    default: {
      res.setHeader('Allow', ['GET']);
      res.status(405).end(`Method ${method} not allowed`);
      break;
    }
  }
}
