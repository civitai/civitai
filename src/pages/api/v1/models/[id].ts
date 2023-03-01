import { ModelHashType } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { isProd } from '~/env/other';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getAllModelsWithVersionsSelect } from '~/server/selectors/model.selector';
import { getModel } from '~/server/services/model.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const schema = z.object({ id: z.preprocess((val) => Number(val), z.number()) });

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: `Invalid id: ${results.error.flatten().fieldErrors.id}` });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelId' });

  const fullModel = await getModel({ input: { id }, select: getAllModelsWithVersionsSelect });
  if (!fullModel) return res.status(404).json({ error: 'Model not found' });

  const baseUrl = new URL(isProd ? `https://${req.headers.host}` : 'http://localhost:3000');

  const { modelVersions, tagsOnModels, user, ...model } = fullModel;
  res.status(200).json({
    ...model,
    creator: {
      username: user.username,
      image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
    },
    tags: tagsOnModels.map(({ tag }) => tag.name),
    modelVersions: modelVersions
      .map(({ images, files, ...version }) => {
        const primaryFile = getPrimaryFile(files);
        if (!primaryFile) return null;

        return {
          ...version,
          files: files.map(({ hashes, ...file }) => ({
            ...file,
            name: getDownloadFilename({ model: fullModel, modelVersion: version, file }),
            hashes: hashesAsObject(hashes),
            downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
              versionId: version.id,
              type: file.type,
              format: file.format,
              primary: primaryFile.id === file.id,
            })}`,
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
  });
});
