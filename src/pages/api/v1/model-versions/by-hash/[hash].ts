import { ModelHashType } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { env } from '~/env/server.mjs';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { resModelVersionDetails } from '~/pages/api/v1/model-versions/[id]';
import { prisma } from '~/server/db/client';
import { getModelVersionApiSelect } from '~/server/selectors/modelVersion.selector';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ hash: z.string() });

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res
      .status(400)
      .json({ error: `Invalid hash: ${results.error.flatten().fieldErrors.hash}` });

  const { hash } = results.data;
  if (!hash) return res.status(400).json({ error: 'Missing hash' });

  const { modelVersion } = (await prisma.modelFile.findFirst({
    where: { hashes: { some: { hash } } },
    take: 1,
    select: {
      modelVersion: {
        select: getModelVersionApiSelect,
      },
    },
  })) ?? { modelVersion: null };

  resModelVersionDetails(req, res, modelVersion);
});
