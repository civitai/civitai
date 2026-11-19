import { queryGatedModelIds } from '~/server/services/paid-access.service';
import {
  queueModelsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

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
 * 🔴 `alreadyQueued` is only meaningful IMMEDIATELY after an enqueue. The 15-minute sync checks
 * this queue out destructively, so any later reading is near zero whatever happened — and a near
 * zero reads naturally as "nothing is queued, safe to write again", which may be the opposite of
 * the truth.
 *
 * History: the one-off backfill this was written for was performed on 2026-09-08 through
 * /api/internal/search-index-update, because this endpoint was not yet deployed. This is not
 * therefore spent — the gated set moves with the wall clock, since `endsAt` is in the predicate —
 * but it is a reconciler rather than a pending step.
 *
 * Usage:
 *   POST /api/admin/temp/queue-paid-models-reindex?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun    - default true. Report the id count and the current queue depth, queue nothing.
 *   chunkSize - default 1000. Ids per queueUpdate call.
 *
 * The response is read back from the queue; what `landed` proves is in `queueModelsReindex`.
 */

export default WebhookEndpoint(async (req, res) => {
  const parsed = queueModelsReindexSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { modelCount, ...result } = await queueModelsReindex(
    await queryGatedModelIds(),
    parsed.data
  );
  return res.status(200).json({ ...result, gatedModelCount: modelCount });
});
