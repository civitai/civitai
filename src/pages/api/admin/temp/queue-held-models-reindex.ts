import * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Queue every published minor or SFW-only model for a models-index rewrite.
 *
 * Admin route, deliberately temporary: delete it once the post-deploy run is done.
 *
 * Purpose: the models search document now carries a minor or SFW-only model's showcase images only
 * within its gallery level. A flag change rewrites the model's document; documents written before
 * this shipped keep their old images until something rewrites them. Run once after the deploy.
 * Re-running is harmless: the enqueue is idempotent.
 *
 * Usage:
 *   POST /api/admin/temp/queue-held-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * `landed` is read back from the queue, as in queue-paid-models-reindex: equal to `heldModelCount`
 * it proves the ids are queued; below it, the 15-minute sync may have checked the queue out in
 * between, so re-run rather than conclude anything.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  chunkSize: z.coerce.number().min(1).max(10000).default(1000),
});

const QUEUE_ACTION = SearchIndexUpdateQueueAction.Update;

async function readQueuedIds() {
  // readOnly: cannot consume work the sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(MODELS_SEARCH_INDEX, QUEUE_ACTION, true);
  return queue.content;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, chunkSize } = parsed.data;

  const models = await dbRead.model.findMany({
    where: { status: ModelStatus.Published, OR: [{ minor: true }, { sfwOnly: true }] },
    select: { id: true },
  });
  const modelIds = models.map(({ id }) => id);
  const before = await readQueuedIds();
  const beforeSet = new Set(before);

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      heldModelCount: modelIds.length,
      queueDepthBefore: before.length,
      alreadyQueued: modelIds.filter((id) => beforeSet.has(id)).length,
    });
  }

  for (let i = 0; i < modelIds.length; i += chunkSize) {
    const chunk = modelIds.slice(i, i + chunkSize);
    await modelsSearchIndex.queueUpdate(chunk.map((id) => ({ id, action: QUEUE_ACTION })));
  }

  const after = await readQueuedIds();
  const afterSet = new Set(after);

  return res.status(200).json({
    dryRun: false,
    heldModelCount: modelIds.length,
    queueDepthBefore: before.length,
    queueDepthAfter: after.length,
    landed: modelIds.filter((id) => afterSet.has(id)).length,
  });
});
