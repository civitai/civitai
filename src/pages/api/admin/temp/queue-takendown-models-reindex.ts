import { dbRead } from '~/server/db/client';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForModelImages,
} from '~/server/services/collection-media-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * Queue every indexed taken-down model for a models-index rewrite, and every collection showing a
 * taken-down model's images for a collections-index rewrite.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: a taken-down model's search document carries no images or cover ids, and the indexer
 * applies that only to documents it rewrites. Likewise a collection's cover skips a taken-down
 * model's images, and an existing collection document is only rewritten when queued. A change of
 * mode queues both from now on; this rewrites those taken down before that.
 *
 * Usage:
 *   POST /api/admin/temp/queue-takendown-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * The models half is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 * `collections` counts the collections found, and says whether any model's lookup hit its cap.
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

/** Every taken-down model, indexed or not: a collection can show any of their images. */
async function queryAllTakenDownModelIds() {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m WHERE m.mode = ${ModelModifier.TakenDown}::"ModelModifier"
  `;
  return rows.map((r) => Number(r.id));
}

async function queueTakenDownCollections(dryRun: boolean) {
  const modelIds = await queryAllTakenDownModelIds();
  const collectionIds = new Set<number>();
  let truncated = false;
  // One model at a time: each lookup reads every image on its model.
  for (const modelId of modelIds) {
    const found = await getCollectionIdsForModelImages({
      modelId,
      source: 'takendown-collections-backfill',
    });
    for (const id of found.collectionIds) collectionIds.add(id);
    truncated ||= found.truncated;
  }
  if (!dryRun)
    await enqueueCollectionRebuild({
      collectionIds: [...collectionIds],
      truncated,
      source: 'takendown-collections-backfill',
    });
  return { models: modelIds.length, collections: collectionIds.size, truncated, dryRun };
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const models = await queueModelsReindex(await queryTakenDownModelIds(), parsed.data);
  const collections = await queueTakenDownCollections(parsed.data.dryRun);
  return res.status(200).json({ ...models, collections });
});
