import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

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
    where: { hashes: { some: { hash } }, modelVersion: { model: { status: 'Published' } } },
    take: 1,
    select: {
      modelVersion: {
        select: getModelVersionApiSelect,
      },
    },
  })) ?? { modelVersion: null };

  resModelVersionDetails(req, res, modelVersion);
});
