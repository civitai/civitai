import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { appRouter } from '~/server/routers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = appRouter.createCaller({ user: undefined });
  try {
    const { items, ...metadata } = await apiCaller.model.getAllWithVersions(req.query);
    const { nextPage, prevPage, baseUrl } = getPaginationLinks({ ...metadata, req });

    res.status(200).json({
      items: items.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ images, files, ...version }) => {
            const hasPrimary = files.findIndex((file) => file.primary) > -1;
            if (!hasPrimary) return null;

            return {
              ...version,
              files: files.map(({ primary, ...file }) => ({
                ...file,
                primary: primary === true ? primary : undefined,
                downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  format: file.format,
                  primary,
                })}`,
              })),
              images: images.map(({ image: { url, ...image } }) => ({
                url: getEdgeUrl(url, { width: 450 }),
                ...image,
              })),
              downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
                versionId: version.id,
                primary: true,
              })}`,
            };
          })
          .filter((x) => x),
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
});
