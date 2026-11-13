import * as z from 'zod';
import { runChildLabelReindex } from '~/server/services/child-label-reindex.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Rewrites cached image tag ids, then search documents, for images that carry a child browsing
 * tag from Rekognition and were also tagged by WD14.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage, in this order:
 *   POST /api/admin/temp/child-label-reindex?token=$WEBHOOK_TOKEN&step=bust&dryRun=false
 *   POST /api/admin/temp/child-label-reindex?token=$WEBHOOK_TOKEN&step=reindex&dryRun=false
 *
 * Params (query):
 *   step      - required. `bust`: refresh each selected image's tagIdsForImagesCache entry from the
 *               database. `reindex`: queue the models and collections whose search documents hold
 *               those images.
 *   dryRun    - default true. Count images, chunks, models and collections; write nothing.
 *   chunkSize - default 500. Image ids per selection query and per refresh; ids per queue push.
 */

const schema = z.object({
  step: z.enum(['bust', 'reindex']),
  dryRun: booleanString().default(true),
  chunkSize: z.coerce.number().min(1).max(5000).default(500),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  return res.status(200).json(await runChildLabelReindex(parsed.data));
});
