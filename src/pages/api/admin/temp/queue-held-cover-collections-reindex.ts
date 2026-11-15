import { dbRead } from '~/server/db/client';
import {
  queueCollectionsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { getCollectionIdsCoveredByModels } from '~/server/services/collection-index-sync';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * The collections search document now carries no cover above a minor or SFW-only model's gallery
 * level, but the indexer applies that only to documents it rewrites. A flag or gallery-level change
 * queues the model's collections from now on; this rewrites those set before that.
 *
 * The response is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 */

const MODEL_CHUNK = 1000;

async function queryHeldCoverCollectionIds() {
  const models = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m WHERE m.minor OR m."sfwOnly"
  `;
  const modelIds = models.map((m) => Number(m.id));
  const collectionIds = new Set<number>();
  for (let i = 0; i < modelIds.length; i += MODEL_CHUNK) {
    for (const id of await getCollectionIdsCoveredByModels(modelIds.slice(i, i + MODEL_CHUNK)))
      collectionIds.add(id);
  }
  return [...collectionIds];
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  return res
    .status(200)
    .json(await queueCollectionsReindex(await queryHeldCoverCollectionIds(), parsed.data));
});
