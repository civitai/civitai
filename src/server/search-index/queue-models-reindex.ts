import type * as z from 'zod';
import { COLLECTIONS_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { collectionsSearchIndex, modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { queueModelsReindexSchema } from '~/server/search-index/queue-models-reindex.schema';

export { queueModelsReindexSchema };

type QueueAction = SearchIndexUpdateQueueAction.Update | SearchIndexUpdateQueueAction.Delete;

type ReindexTarget = {
  indexName: string;
  index: {
    queueUpdate: (items: { id: number; action: QueueAction }[]) => Promise<unknown>;
  };
};

async function readQueuedIds(indexName: string, action: QueueAction) {
  // readOnly: does NOT append a new bucket or retire the current ones, so calling this cannot
  // consume work the 15-minute sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(indexName, action, true);
  return queue.content;
}

/**
 * Queue models for a models-index rewrite, for the admin backfill endpoints.
 *
 * `queueDepthBefore`/`queueDepthAfter` are READ BACK from the queue, not inferred from the call
 * returning: `addToQueue` fails open on a degraded sysRedis (it parks the ids in Postgres and
 * returns false) and `modelsSearchIndex.queueUpdate` does not propagate that boolean.
 *
 * `landed` is one-directional evidence. Equal to `modelCount`, it proves the ids are queued. Below
 * it, the ids may have been dropped OR the 15-minute sync may have checked the queue out
 * destructively between the enqueue and the read, so a low count is a reason to re-run. Re-running
 * is harmless; the enqueue is idempotent. `alreadyQueued` likewise means something only right
 * after an enqueue.
 */
export async function queueModelsReindex(
  modelIds: number[],
  options: z.infer<typeof queueModelsReindexSchema>,
  /** Delete removes the documents instead of rewriting them. */
  action: QueueAction = SearchIndexUpdateQueueAction.Update
) {
  const { count, ...result } = await queueReindex(
    { indexName: MODELS_SEARCH_INDEX, index: modelsSearchIndex },
    modelIds,
    options,
    action
  );
  return { modelCount: count, ...result };
}

/** `queueModelsReindex` for the collections index. */
export async function queueCollectionsReindex(
  collectionIds: number[],
  options: z.infer<typeof queueModelsReindexSchema>
) {
  const { count, ...result } = await queueReindex(
    { indexName: COLLECTIONS_SEARCH_INDEX, index: collectionsSearchIndex },
    collectionIds,
    options
  );
  return { collectionCount: count, ...result };
}

async function queueReindex(
  { indexName, index }: ReindexTarget,
  ids: number[],
  { dryRun, chunkSize }: z.infer<typeof queueModelsReindexSchema>,
  action: QueueAction = SearchIndexUpdateQueueAction.Update
) {
  const before = await readQueuedIds(indexName, action);
  // Set, not Array.includes: this queue reaches ~211K ids on a large fan-out, and scanning it once
  // per id is enough to wedge the handler.
  const beforeSet = new Set(before);

  if (dryRun) {
    return {
      dryRun: true,
      count: ids.length,
      queueDepthBefore: before.length,
      alreadyQueued: ids.filter((id) => beforeSet.has(id)).length,
    };
  }

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await index.queueUpdate(chunk.map((id) => ({ id, action })));
  }

  const after = await readQueuedIds(indexName, action);
  const afterSet = new Set(after);
  return {
    dryRun: false,
    count: ids.length,
    queueDepthBefore: before.length,
    queueDepthAfter: after.length,
    landed: ids.filter((id) => afterSet.has(id)).length,
  };
}
