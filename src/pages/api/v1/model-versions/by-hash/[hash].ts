import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { resModelVersionDetails } from '~/pages/api/v1/model-versions/[id]';
import { dbRead } from '~/server/db/client';
import { getModelVersionApiSelect } from '~/server/selectors/modelVersion.selector';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  hash: z.string().transform((hash) => hash.toUpperCase()),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid hash' });

  const { hash } = results.data;
  if (!hash) return res.status(400).json({ error: 'Missing hash' });

  const { modelVersion } = (await dbRead.modelFile.findFirst({
    where: {
      hashes: { some: { hash } },
      modelVersion: { model: { status: 'Published' }, status: 'Published' },
    },
    // Duplicate hashes are a known condition (see src/pages/moderator/duplicate-hashes.tsx):
    // a single hash can map to multiple Published files/versions. Without an explicit order
    // `findFirst` returns a plan-dependent, arbitrary row, so repeated calls for the same hash
    // can resolve to different versions. Order deterministically by the oldest/canonical
    // version (earliest publishedAt, then lowest version id as a stable tiebreaker) so the
    // result is stable. This makes resolution deterministic, not disambiguated.
    orderBy: [{ modelVersion: { publishedAt: 'asc' } }, { modelVersion: { id: 'asc' } }],
    take: 1,
    select: {
      modelVersion: {
        select: getModelVersionApiSelect,
      },
    },
  })) ?? { modelVersion: null };

  await resModelVersionDetails(req, res, modelVersion);
});
