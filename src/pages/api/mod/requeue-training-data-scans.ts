import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { requeuePendingTrainingDataScans } from '~/server/services/training-data-scan.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Submits the Training Data zips still Pending to their virus scan, one page per call.
 *
 *   GET  ?limit=&afterId=   counts them and submits nothing
 *   POST ?limit=&afterId=   submits the page; pass the returned `nextAfterId` for the next one
 */
const schema = z.object({
  // Each zip is copied in full inside this request, so pages stay small.
  limit: z.coerce.number().int().min(1).max(25).default(10),
  afterId: z.coerce.number().int().optional(),
});

export default ModEndpoint(
  async function requeueTrainingDataScans(req: NextApiRequest, res: NextApiResponse) {
    const { limit, afterId } = schema.parse(req.query);
    const result = await requeuePendingTrainingDataScans({
      limit,
      afterId,
      dryRun: req.method !== 'POST',
    });
    res.status(200).json(result);
  },
  ['GET', 'POST']
);
