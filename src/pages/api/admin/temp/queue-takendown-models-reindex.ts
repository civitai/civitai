import { dbRead } from '~/server/db/client';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * Queue every indexed taken-down model for a models-index rewrite.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: a taken-down model's search document carries no images or cover ids, and the indexer
 * applies that only to documents it rewrites. A change of mode queues the rewrite from now on;
 * this rewrites the models taken down before that.
 *
 * Usage:
 *   POST /api/admin/temp/queue-takendown-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * The response is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 */

async function queryTakenDownModelIds() {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id
    FROM "Model" m
    WHERE m.mode = ${ModelModifier.TakenDown}::"ModelModifier"
      AND ${modelSearchIndexEligibilitySql()}
  `;
  return rows.map((r) => Number(r.id));
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  return res
    .status(200)
    .json(await queueModelsReindex(await queryTakenDownModelIds(), parsed.data));
});
