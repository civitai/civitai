import { dbRead } from '~/server/db/client';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Backfill: the indexer applies the showcase hold only to documents it rewrites, so models flagged
 * before the hold need a requeue. The response is read back from the queue; see
 * `queueModelsReindex` for what `landed` proves.
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
