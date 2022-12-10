import { ModelFileType } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '~/server/db/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';

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

  const modelFiles = files.filter((x) => x.type === ModelFileType.Model);
  if (modelFiles.length === 0) return res.status(404).json({ error: 'Missing model file' });

  res.status(200).json({
    ...version,
    model,
    files: modelFiles.map(({ type, ...file }) => ({ ...file })),
    images: images.map(({ image: { url, ...image } }) => ({
      url: getEdgeUrl(url, { width: 450 }),
      ...image,
    })),
    downloadUrl: `${baseUrl.origin}/api/download/models/${version.id}`,
  });
});
