import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { env } from '~/env/server.mjs';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { prisma } from '~/server/db/client';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ id: z.preprocess((val) => Number(val), z.number()) });

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: `Invalid id: ${results.error.flatten().fieldErrors.id}` });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelVersionId' });

  const modelVersion = await prisma.modelVersion.findFirst({
    where: { id },
    select: {
      ...getModelVersionDetailsSelect,
      modelId: true,
      model: {
        select: { name: true, type: true, nsfw: true, poi: true },
      },
    },
  });
  if (!modelVersion) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const baseUrl = new URL(
    env.NODE_ENV === 'production' ? `https://${req.headers.host}` : 'http://localhost:3000'
  );

  const { images, files, model, ...version } = modelVersion;
  const hasPrimary = files.findIndex((file) => file.primary) > -1;
  if (!hasPrimary) return res.status(404).json({ error: 'Missing model file' });

  res.status(200).json({
    ...version,
    model,
    files: files.map(({ primary, ...file }) => ({
      ...file,
      name: getDownloadFilename({ model, modelVersion: version, file }),
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
  });
});
