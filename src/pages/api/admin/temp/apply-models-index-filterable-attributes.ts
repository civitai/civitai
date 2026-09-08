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
 * instance has taken 51 minutes. Treat it as a maintenance operation with an owner watching.
 *
 * Two refusals, because `updateFilterableAttributes` REPLACES the list rather than merging into it:
 *
 * - Anything live on the index but missing from the code list would be DELETED by the write. Drift
 *   is not directional and the repo cannot see which way it has gone, so a non-empty `extra`
 *   refuses unless `allowRemove=true`. Removing a filterable attribute makes every query using it
 *   answer `invalid_search_filter`, and undoing it costs a second full reindex.
 * - The write returns as soon as the task is ENQUEUED, while `getFilterableAttributes` reports what
 *   is APPLIED. In between, a second call sees the same `missing` and enqueues a second full
 *   reindex. There is no method guard on `WebhookEndpoint`, so a browser reload is enough. A
 *   pending settings task therefore refuses unless `force=true`.
 *
 * Usage:
 *   POST /api/admin/temp/apply-models-index-filterable-attributes?token=$WEBHOOK_TOKEN
 *     &dryRun=false
 *
 * Params (query):
 *   dryRun     - default true. Report the current list and what would change, write nothing.
 *   allowRemove - default false. Permit a write that removes attributes the live index has.
 *   force      - default false. Permit a write while a settings task is already enqueued.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  allowRemove: booleanString().default(false),
  force: booleanString().default(false),
});

// Returns null when the tasks API could not be reached or refused. That is deliberately distinct
// from an empty array: an empty array means "checked, nothing pending", null means "do not know",
// and the write path treats not-knowing as a refusal. Swallowing the difference would turn a
// permissions or availability problem into a green light for a full-index reindex.
//
// The SDK scopes this to the index handle (it sends indexUids=<uid>), so it does not scan globally.
async function pendingSettingsTaskUids(index: {
  getTasks: (q: { statuses: string[]; types: string[] }) => Promise<{ results: { uid: number }[] }>;
}) {
  try {
    const tasks = await index.getTasks({
      statuses: ['enqueued', 'processing'],
      types: ['settingsUpdate'],
    });
    return tasks.results.map((t) => t.uid);
  } catch {
    return null;
  }
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, allowRemove, force } = parsed.data;

  if (!searchClient) return res.status(503).json({ error: 'search client not configured' });

  // `index()` is a local handle — unlike getOrCreateIndex it cannot create an index as a side
  // effect of a typo in the name.
  const index = searchClient.index(MODELS_SEARCH_INDEX);
  const current = (await index.getFilterableAttributes()) ?? [];
  const desired = [...modelsFilterableAttributes];

  const missing = desired.filter((a) => !current.includes(a));
  const extra = current.filter((a) => !desired.includes(a as never));
  const pending = await pendingSettingsTaskUids(index as never);

  if (dryRun) {
    // Reports `pending: null` rather than failing when the tasks API is unreachable, so the read-only
    // path still answers the question it is for — what would change — even if the write could not run.
    return res.status(200).json({ dryRun: true, current, desired, missing, extra, pending });
  }

  if (!missing.length && !extra.length) {
    return res.status(200).json({ dryRun: false, unchanged: true, current });
  }

  if (extra.length && !allowRemove) {
    return res.status(409).json({
      error: 'refusing to remove filterable attributes',
      extra,
      hint: 'pass allowRemove=true only if you intend the live index to lose these',
    });
  }

  if (pending === null && !force) {
    return res.status(409).json({
      error: 'could not determine whether a settings task is already pending',
      hint: 'the tasks API was unreachable or refused; SEARCH_API_KEY may lack tasks.get. Pass force=true only if you have checked by hand',
    });
  }

  if (pending?.length && !force) {
    return res.status(409).json({
      error: 'a settings task is already enqueued on this index',
      pending,
      hint: 'wait for it to apply, then re-read; pass force=true only to enqueue a second reindex',
    });
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
