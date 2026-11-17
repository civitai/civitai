import * as z from 'zod';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import { queueModelsReindex } from '~/server/search-index/queue-models-reindex';
import { queueModelsReindexSchema } from '~/server/search-index/queue-models-reindex.schema';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForModelImages,
  isCoverLegUsable,
} from '~/server/services/collection-media-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * Queue every indexed taken-down model for a models-index rewrite (`target=models`, the default),
 * or the collections showing taken-down models' images for a collections-index rewrite
 * (`target=collections`).
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: a taken-down model's search document carries no images or cover ids, and a
 * collection's cover skips a taken-down model's images, but the indexers apply that only to
 * documents they rewrite, and an existing collection document is rewritten only when queued. A
 * change of mode queues both from now on; this rewrites those taken down before that.
 *
 * Usage:
 *   POST /api/admin/temp/queue-takendown-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *   POST ...&target=collections&dryRun=false&afterId=0, then again with each `nextAfterId` until
 *   it is null.
 *
 * Params (query):
 *   dryRun    - default true. Report what would be queued, queue nothing.
 *   chunkSize - default 1000. Model ids per queueUpdate call (target=models).
 *   target    - models (default) or collections.
 *   afterId   - collections only: take the taken-down models after this id. Default 0.
 *   take      - collections only: how many models per call, each looked up in turn. Default 25.
 *
 * models: read back from the queue; what `landed` proves is in `queueModelsReindex`.
 * collections: `collections` is how many were found for this page of models, and `landed` how
 * many of those are in the queue afterwards. Low means the enqueue failed or the sync checked the
 * queue out in between; either way, re-run the page, which is harmless.
 * `failedModelIds` lists models whose lookup failed and found nothing, and `truncated` says a
 * model's lookup hit its cap; either means this page is incomplete.
 */

const schema = queueModelsReindexSchema.extend({
  target: z.enum(['models', 'collections']).default('models'),
  afterId: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(25),
});

const SOURCE = 'takendown-collections-backfill';

async function queryTakenDownModelIds() {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id
    FROM "Model" m
    WHERE m.mode = ${ModelModifier.TakenDown}::"ModelModifier"
      AND ${modelSearchIndexEligibilitySql()}
  `;
  return rows.map((r) => Number(r.id));
}

/** A page of taken-down models, indexed or not: a collection can show any of their images. */
async function queryTakenDownModelPage(afterId: number, take: number) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE m.mode = ${ModelModifier.TakenDown}::"ModelModifier" AND m.id > ${afterId}
    ORDER BY m.id
    LIMIT ${take}
  `;
  return rows.map((r) => Number(r.id));
}

async function readQueuedCollectionIds() {
  // readOnly: reading cannot consume work the sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(
    COLLECTIONS_SEARCH_INDEX,
    SearchIndexUpdateQueueAction.Update,
    true
  );
  return new Set(queue.content);
}

async function queueTakenDownCollections({
  dryRun,
  afterId,
  take,
}: {
  dryRun: boolean;
  afterId: number;
  take: number;
}) {
  const modelIds = await queryTakenDownModelPage(afterId, take);
  const withCover = await isCoverLegUsable(SOURCE);
  const collectionIds = new Set<number>();
  const failedModelIds: number[] = [];
  let truncated = false;
  // One model at a time: each lookup reads every image on its model.
  for (const modelId of modelIds) {
    const found = await getCollectionIdsForModelImages({ modelId, source: SOURCE, withCover });
    if (found.failed) failedModelIds.push(modelId);
    for (const id of found.collectionIds) collectionIds.add(id);
    truncated ||= found.truncated;
  }
  const page = {
    target: 'collections' as const,
    dryRun,
    models: modelIds.length,
    nextAfterId: modelIds.length === take ? modelIds[modelIds.length - 1] : null,
    collections: collectionIds.size,
    failedModelIds,
    truncated,
    coverLeg: withCover,
  };
  if (dryRun) return page;

  await enqueueCollectionRebuild({ collectionIds: [...collectionIds], truncated, source: SOURCE });
  const queued = await readQueuedCollectionIds();
  return { ...page, landed: [...collectionIds].filter((id) => queued.has(id)).length };
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.target === 'collections')
    return res.status(200).json(await queueTakenDownCollections(parsed.data));

  return res
    .status(200)
    .json(await queueModelsReindex(await queryTakenDownModelIds(), parsed.data));
});
