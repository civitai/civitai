import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead } from '~/server/db/client';
import {
  getHiddenModelVersionIds,
  isPrivateModelVersion,
} from '~/server/services/model-visibility.service';
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
              id: true,
              modelId: true,
              availability: true,
              model: { select: { poi: true, availability: true, userId: true } },
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
    const hidden = await getHiddenModelVersionIds(
      matched.map((entry) => entry.modelVersion),
      async () => (await getServerAuthSession({ req, res }))?.user
    );
    const visible = matched.filter((entry) => !hidden.has(entry.modelVersionId));
    const ids = visible.map((entry) => ({
      modelVersionId: entry.modelVersionId,
      modelId: entry.modelVersion.modelId,
      hash: entry.hashes[0].hash,
    }));

    // Only its owner or a moderator is still holding a Private version here.
    if (visible.some((entry) => isPrivateModelVersion(entry.modelVersion)))
      res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(ids);
  },
  ['POST']
);
