import * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Apply `modelsFilterableAttributes` to the LIVE models index.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Why this exists: nothing else can apply the list without a full rebuild. Each index's
 * `onIndexSetup` is the only in-repo writer of these settings, and it runs in exactly one place —
 * `reset()` in base.search-index.ts — against the `_NEW` swap index. So adding an attribute to the
 * list is INERT on the live index until either a reset rebuilds all ~705K documents, or this runs.
 *
 * 🔴 Meilisearch reindexes the filterable fields across every document in the index when this list
 * changes. The cost on this index has never been measured, and one `images_v6` batch on this
 * instance has taken 51 minutes. Treat it as a maintenance operation with an owner watching, not as
 * a deploy step: check the queue is quiet first, and poll the returned task uid.
 *
 * Usage:
 *   POST /api/admin/temp/apply-models-index-filterable-attributes?token=$WEBHOOK_TOKEN
 *     &dryRun=false
 *
 * Params (query):
 *   dryRun - default true. Report the current list and what would be added, write nothing.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun } = parsed.data;

  if (!searchClient) return res.status(503).json({ error: 'search client not configured' });

  // `index()` is a local handle — unlike getOrCreateIndex it cannot create an index as a side
  // effect of a typo in the name.
  const index = searchClient.index(MODELS_SEARCH_INDEX);
  const current = (await index.getFilterableAttributes()) ?? [];
  const desired = [...modelsFilterableAttributes];

  const missing = desired.filter((a) => !current.includes(a));
  const extra = current.filter((a) => !desired.includes(a as never));

  if (dryRun) {
    return res.status(200).json({ dryRun: true, current, desired, missing, extra });
  }

  if (!missing.length && !extra.length) {
    return res.status(200).json({ dryRun: false, unchanged: true, current });
  }

  const task = await index.updateFilterableAttributes(desired);

  return res.status(200).json({
    dryRun: false,
    unchanged: false,
    added: missing,
    removed: extra,
    // Poll this. The call returns as soon as the task is ENQUEUED, which on a busy instance is a
    // long way from applied.
    taskUid: task.taskUid,
  });
});
