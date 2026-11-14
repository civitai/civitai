import { dbRead } from '~/server/db/client';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Queue every indexed minor or SFW-only model for a models-index rewrite.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: the models search document now carries only the showcase images within a minor or
 * SFW-only model's gallery level, but the indexer applies that only to documents it rewrites. A
 * flag or gallery-level change queues the model from now on; this rewrites those set before that.
 *
 * Usage:
 *   POST /api/admin/temp/queue-held-showcase-models-reindex?token=$WEBHOOK_TOKEN
 *   then again with &dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * The response is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 */

async function queryHeldModelIds() {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id
    FROM "Model" m
    WHERE (m.minor OR m."sfwOnly")
      AND ${modelSearchIndexEligibilitySql()}
  `;
  return rows.map((r) => Number(r.id));
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  return res.status(200).json(await queueModelsReindex(await queryHeldModelIds(), parsed.data));
});
