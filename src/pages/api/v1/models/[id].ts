import { ModelHashType, ModelModifier } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { publicApiContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const schema = z.object({ id: z.preprocess((val) => Number(val), z.number()) });

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: `Invalid id: ${results.error.flatten().fieldErrors.id}` });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelId' });

  const baseUrl = getBaseUrl();

  const apiCaller = appRouter.createCaller({ ...publicApiContext });
  try {
    const { modelVersions, tagsOnModels, user, ...model } =
      await apiCaller.model.getByIdWithVersions({ id });

    res.status(200).json({
      ...model,
      mode: model.mode == null ? undefined : model.mode,
      creator: {
        username: user.username,
        image: user.image ? getEdgeUrl(user.image, { width: 96, name: user.username }) : null,
      },
      tags: tagsOnModels.map((tag) => tag.tag),
      modelVersions: modelVersions
        .map(({ images, files, ...version }) => {
          const castedFiles = files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
          >;
          const primaryFile = getPrimaryFile(castedFiles);
          if (!primaryFile) return null;

          const includeDownloadUrl = model.mode !== ModelModifier.Archived;
          const includeImages = model.mode !== ModelModifier.TakenDown;

          return {
            ...version,
            files: includeDownloadUrl
              ? castedFiles.map(({ hashes, ...file }) => ({
                  ...file,
                  name: getDownloadFilename({ model, modelVersion: version, file }),
                  hashes: hashesAsObject(hashes),
                  downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                    versionId: version.id,
                    type: file.type,
                    format: file.metadata.format,
                    primary: primaryFile.id === file.id,
                  })}`,
                  primary: primaryFile.id === file.id ? true : undefined,
                }))
              : [],
            images: includeImages
              ? images.map(({ url, id, ...image }) => ({
                  url: getEdgeUrl(url, { width: 450, name: id.toString() }),
                  ...image,
                }))
              : [],
            downloadUrl: includeDownloadUrl
              ? `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  primary: true,
                })}`
              : undefined,
          };
        })
        .filter((x) => x),
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
