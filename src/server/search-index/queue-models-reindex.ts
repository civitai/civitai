import type * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { queueModelsReindexSchema } from '~/server/search-index/queue-models-reindex.schema';

export { queueModelsReindexSchema };

const QUEUE_ACTION = SearchIndexUpdateQueueAction.Update;

async function readQueuedIds() {
  // readOnly: does NOT append a new bucket or retire the current ones, so calling this cannot
  // consume work the 15-minute sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(MODELS_SEARCH_INDEX, QUEUE_ACTION, true);
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
  { dryRun, chunkSize }: z.infer<typeof queueModelsReindexSchema>
) {
  const before = await readQueuedIds();
  // Set, not Array.includes: this queue reaches ~211K ids on a large fan-out, and scanning it once
  // per model is enough to wedge the handler.
  const beforeSet = new Set(before);

  if (dryRun) {
    return {
      dryRun: true,
      modelCount: modelIds.length,
      queueDepthBefore: before.length,
      alreadyQueued: modelIds.filter((id) => beforeSet.has(id)).length,
    };
  }

  for (let i = 0; i < modelIds.length; i += chunkSize) {
    const chunk = modelIds.slice(i, i + chunkSize);
    await modelsSearchIndex.queueUpdate(chunk.map((id) => ({ id, action: QUEUE_ACTION })));
  }

  const after = await readQueuedIds();
  const afterSet = new Set(after);
  return {
    dryRun: false,
    modelCount: modelIds.length,
    queueDepthBefore: before.length,
    queueDepthAfter: after.length,
    landed: modelIds.filter((id) => afterSet.has(id)).length,
  };
}
