import * as z from 'zod';
import {
  MAX_BLOB_REFRESH_BATCH,
  refreshBlobsService,
} from '~/server/services/orchestrator/refreshBlobs';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  // Same charset the blob-url matcher accepts, so a path param can't be anything else.
  blobIds: z
    .array(z.string().regex(/^[a-zA-Z0-9_.-]+$/))
    .min(1)
    .max(MAX_BLOB_REFRESH_BATCH),
});

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid blobIds' });

    try {
      const results = await refreshBlobsService({ token, blobIds: parsed.data.blobIds });
      return res.status(200).json({ results });
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  },
  ['POST']
);
