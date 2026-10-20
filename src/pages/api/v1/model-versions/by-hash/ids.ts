import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead } from '~/server/db/client';
import { getHiddenModelIds } from '~/server/services/model-visibility.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .array(
    z
      .string()
      .refine((hash) => hash.length === 64, { error: 'Invalid hash' })
      .transform((hash) => hash.toUpperCase())
  )
  .max(10000, { error: 'Too many hashes' });

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.body);
    if (!results.success)
      return res.status(400).json({
        error: `Request must include an array of SHA256 Hashes. ${results.error.message}`,
      });

    const matched =
      (await dbRead.modelFile.findMany({
        where: {
          hashes: { some: { hash: { in: results.data }, type: 'SHA256' } },
          modelVersion: { model: { status: 'Published' }, status: 'Published' },
        },
        select: {
          modelVersionId: true,
          modelVersion: {
            select: {
              modelId: true,
              model: { select: { poi: true } },
            },
          },
          hashes: {
            select: {
              hash: true,
            },
            where: {
              type: 'SHA256',
            },
          },
        },
      })) ?? [];

    // Versions the caller may not see are left out, as if their hashes had not matched.
    const flaggedModelIds = matched
      .filter((entry) => entry.modelVersion.model.poi)
      .map((entry) => entry.modelVersion.modelId);
    const hidden = flaggedModelIds.length
      ? await getHiddenModelIds(flaggedModelIds, (await getServerAuthSession({ req, res }))?.user)
      : new Set<number>();
    const ids = matched
      .filter((entry) => !hidden.has(entry.modelVersion.modelId))
      .map((entry) => ({
        modelVersionId: entry.modelVersionId,
        modelId: entry.modelVersion.modelId,
        hash: entry.hashes[0].hash,
      }));

    res.status(200).json(ids);
  },
  ['POST']
);
