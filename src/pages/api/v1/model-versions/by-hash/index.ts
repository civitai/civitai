import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { isProd } from '~/env/other';
import { prepareModelVersionResponse } from '~/pages/api/v1/model-versions/[id]';
import { dbRead } from '~/server/db/client';
import { getModelVersionApiSelect } from '~/server/selectors/modelVersion.selector';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .array(
    z
      .string()
      .refine((hash) => hash.length === 64, { message: 'Invalid hash' })
      .transform((hash) => hash.toUpperCase())
  )
  .max(100, { message: 'Too many hashes' });

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.body);
    if (!results.success)
      return res.status(400).json({
        error: `Request must include an array of SHA256 Hashes. ${results.error.message}`,
      });

    const files = await dbRead.modelFile.findMany({
      where: {
        hashes: { some: { hash: { in: results.data }, type: 'SHA256' } },
        modelVersion: { model: { status: 'Published' } },
      },
      select: {
        modelVersion: {
          select: getModelVersionApiSelect,
        },
      },
    });

    const baseUrl = new URL(isProd ? `https://${req.headers.posthost}` : 'http://localhost:3000');
    const modelVersions = files.map((file) =>
      prepareModelVersionResponse(file.modelVersion, baseUrl)
    );

    res.status(200).json(modelVersions);
  },
  ['POST']
);
