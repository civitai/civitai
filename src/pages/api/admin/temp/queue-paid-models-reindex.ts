import * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { queryGatedModelIds } from '~/server/services/paid-access.service';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Queue every model with a live paid-access gate for a models-index rewrite.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose: `hasActivePaidAccess` was added to the models search document, and the deployed indexer
 * writes it — but only for documents it has rewritten since. Existing documents predate the field.
 * Only GATED models need queueing: the card and the search filter both treat an absent attribute as
 * false, so the ~700K ungated documents are already correct and rewriting them would be waste.
 *
 * Usage:
 *   POST /api/admin/temp/queue-paid-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * Response reports `queueDepthBefore` and `queueDepthAfter` as READ BACK from the queue, not as
 * inferred from the call returning. `addToQueue` fails open on a degraded sysRedis — it parks the
 * ids in Postgres and returns false — and neither `SearchIndexUpdate.queueUpdate` nor
 * `modelsSearchIndex.queueUpdate` propagates that boolean. So "the call returned" is not evidence
 * the ids landed.
 *
 * `landed` is one-directional evidence. Equal to `gatedModelCount` it proves the ids are queued.
 * BELOW it, the ids may have been dropped OR the 15-minute search-index sync may have checked the
 * queue out destructively between the enqueue and the read — a low count is a reason to re-run,
 * not a diagnosis. Re-running is harmless; the enqueue is idempotent.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  chunkSize: z.coerce.number().min(1).max(10000).default(1000),
});

const QUEUE_ACTION = SearchIndexUpdateQueueAction.Update;

async function readQueuedIds() {
  // readOnly: does NOT append a new bucket or retire the current ones, so calling this cannot
  // consume work the 15-minute sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(MODELS_SEARCH_INDEX, QUEUE_ACTION, true);
  return queue.content;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, chunkSize } = parsed.data;

  const modelIds = await queryGatedModelIds();
  const before = await readQueuedIds();
  // Set, not Array.includes: this queue reaches ~211K ids on a large fan-out, and scanning it once
  // per gated model is enough to wedge the handler.
  const beforeSet = new Set(before);

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      gatedModelCount: modelIds.length,
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
  const landed = modelIds.filter((id) => afterSet.has(id)).length;

  return res.status(200).json({
    dryRun: false,
    gatedModelCount: modelIds.length,
    queueDepthBefore: before.length,
    queueDepthAfter: after.length,
    // `landed === gatedModelCount` is proof the ids are queued. A lower number is ambiguous — see
    // the note at the top of this file — and the response to it is to re-run.
    landed,
  });
});
