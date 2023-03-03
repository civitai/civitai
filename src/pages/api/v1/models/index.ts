import { ModelHashType } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { Session } from 'next-auth';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { publicApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { GetAllModelsInput } from '~/server/schema/model.schema';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const authedOnlyOptions: Array<keyof GetAllModelsInput> = ['favorites', 'hidden'];

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  const apiCaller = appRouter.createCaller({ ...publicApiContext, user });
  try {
    if (Object.keys(req.query).some((key: any) => authedOnlyOptions.includes(key)) && !user)
      return res.status(401).json({ error: 'Unauthorized' });

    const { items, ...metadata } = await apiCaller.model.getAllWithVersions(req.query);
    const { nextPage, prevPage, baseUrl } = getPaginationLinks({ ...metadata, req });

    const preferredFormat = {
      type: user?.preferredPrunedModel ? 'Pruned Model' : undefined,
      format: user?.preferredModelFormat,
    };
    const primaryFileOnly = req.query.primaryFileOnly === 'true';

    res.status(200).json({
      items: items.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96, name: user.username }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ images, files, ...version }) => {
            const primaryFile = getPrimaryFile(files, preferredFormat);
            if (!primaryFile) return null;
            if (primaryFileOnly) files = [primaryFile];

            return {
              ...version,
              files: files.map(({ hashes, ...file }) => ({
                ...file,
                name: getDownloadFilename({ model, modelVersion: version, file }),
                hashes: hashesAsObject(hashes),
                downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  format: file.format,
                  primary: primaryFile.id === file.id,
                })}`,
                primary: primaryFile.id === file.id ? true : undefined,
              })),
              images: images.map(({ image: { url, id, ...image } }) => ({
                url: getEdgeUrl(url, { width: 450, name: id.toString() }),
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
