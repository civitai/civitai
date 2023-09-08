import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .array(
    z
      .string()
      .refine((hash) => hash.length === 64, { message: 'Invalid hash' })
      .transform((hash) => hash.toUpperCase())
  )
  .max(10000, { message: 'Too many hashes' });

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.body);
    if (!results.success)
      return res.status(400).json({
        error: `Request must include an array of SHA256 Hashes. ${results.error.message}`,
      });

    const ids =
      (
        await dbRead.modelFile.findMany({
          where: {
            hashes: { some: { hash: { in: results.data }, type: 'SHA256' } },
            modelVersion: { model: { status: 'Published' }, status: 'Published' },
          },
          select: {
            modelVersionId: true,
            hashes: {
              select: {
                hash: true,
              },
              where: {
                type: 'SHA256',
              },
            },
          },
        })
      )?.map((entry) => ({ modelVersionId: entry.modelVersionId, hash: entry.hashes[0].hash })) ??
      [];

    res.status(200).json(ids);
  },
  ['POST']
);
