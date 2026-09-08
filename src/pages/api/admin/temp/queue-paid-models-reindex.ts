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
 * the ids landed; the delta between the two depths is.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  chunkSize: z.coerce.number().min(1).max(10000).default(1000),
});

const QUEUE_ACTION = SearchIndexUpdateQueueAction.Update;

async function readQueuedIds() {
  // readOnly: does NOT append a new bucket or retire the current ones, so calling this cannot
  // consume work the */15 sync is about to pick up.
  const queue = await SearchIndexUpdate.getQueue(MODELS_SEARCH_INDEX, QUEUE_ACTION, true);
  return queue.content;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, chunkSize } = parsed.data;

  const modelIds = await queryGatedModelIds();
  const before = await readQueuedIds();

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      gatedModelCount: modelIds.length,
      queueDepthBefore: before.length,
      alreadyQueued: modelIds.filter((id) => before.includes(id)).length,
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
    // The number that decides whether this worked. `landed < gatedModelCount` means sysRedis
    // dropped ids; they are parked in KeyValue under `search-index-queue-fallback:` and the
    // `search-index-queue-drain` job replays them. Re-run rather than assuming.
    landed,
  });
});
