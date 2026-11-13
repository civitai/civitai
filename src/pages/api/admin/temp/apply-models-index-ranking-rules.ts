import * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import { modelsRankingRules } from '~/server/search-index/ranking-rules';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Apply `modelsRankingRules` to the LIVE models index.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * `onIndexSetup` in models.search-index.ts writes the same list, but only from `reset()` against the
 * `_NEW` swap index, so editing the list changes nothing live until this runs.
 *
 * A pure reorder applies in milliseconds. A rule naming a field no earlier rule named (e.g.
 * `isOfficial:desc`) makes Meilisearch build facet data for that field across every document, so
 * the task can queue behind other indexing work: poll the returned `taskUid` until it succeeds.
 *
 * Usage:
 *   POST /api/admin/temp/apply-models-index-ranking-rules?token=$WEBHOOK_TOKEN&dryRun=false
 *
 * Params (query):
 *   dryRun - default true. Report the live and desired rules, write nothing.
 *   force  - default false. Permit a write while a settings task is already enqueued, or when the
 *            tasks API cannot say whether one is.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  force: booleanString().default(false),
});

// null means "could not tell", which the write path treats as a refusal; [] means "nothing pending".
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
  const { dryRun, force } = parsed.data;

  if (!searchClient) return res.status(503).json({ error: 'search client not configured' });

  // `index()` is a local handle: unlike getOrCreateIndex it cannot create an index from a typo.
  const index = searchClient.index(MODELS_SEARCH_INDEX);
  const current = (await index.getRankingRules()) ?? [];
  const desired = [...modelsRankingRules];
  const unchanged = JSON.stringify(current) === JSON.stringify(desired);
  const pending = await pendingSettingsTaskUids(index as never);

  if (dryRun) return res.status(200).json({ dryRun: true, current, desired, unchanged, pending });

  if (unchanged) return res.status(200).json({ dryRun: false, unchanged: true, current });

  if (pending === null && !force) {
    return res.status(409).json({
      error: 'could not determine whether a settings task is already pending',
      hint: 'the tasks API was unreachable or refused; pass force=true only if you have checked by hand',
    });
  }

  if (pending?.length && !force) {
    return res.status(409).json({
      error: 'a settings task is already enqueued on this index',
      pending,
      hint: 'wait for it to apply, then re-read; pass force=true to enqueue anyway',
    });
  }

  const task = await index.updateRankingRules(desired);

  return res.status(200).json({
    dryRun: false,
    unchanged: false,
    previous: current,
    applied: desired,
    taskUid: task.taskUid,
  });
});
