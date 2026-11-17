import { dbRead } from '~/server/db/client';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Queue every model with an accelerator LoRA version for a models-index rewrite.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: `versions.accelerator` was added to the models search document, and the indexer writes
 * it only for documents it has rewritten since. Only models with a version whose settings carry an
 * accelerator or a turbo block need queueing: every other document is already right with the field
 * absent. Apply the filterable attribute first (`apply-models-index-filterable-attributes`), or a
 * filter on the field fails until it is.
 *
 * Usage:
 *   POST /api/admin/temp/queue-accelerator-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * The response is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 */

async function queryAcceleratorModelIds() {
  const rows = await dbRead.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT "modelId"
    FROM "ModelVersion"
    WHERE settings->>'accelerator' IS NOT NULL
       OR jsonb_typeof(settings->'turbo') = 'object'
  `;
  return rows.map((r) => Number(r.modelId));
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  return res
    .status(200)
    .json(await queueModelsReindex(await queryAcceleratorModelIds(), parsed.data));
});
