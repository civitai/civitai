import * as z from 'zod';
import {
  backfillStatus,
  finalizeBatch,
  revertBatch,
  setPaused,
  stageRange,
  startBackfill,
} from '~/server/metrics/model-image-count-backfill';
import { recountVersions } from '~/server/metrics/model-image-count';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Rebuilds ModelVersionMetric.imageCount once, then hands it to update-model-image-counts.
 * Every call is ?token=$WEBHOOK_TOKEN&mode=…
 *   status                 progress, unstaged id ranges, watermark
 *   start                  pins the cutoff hour and the top Image id (idempotent)
 *   stage&start=&end=      counts that Image id range into staging; dryRun=true (default) writes nothing
 *   finalize&limit=2000    swaps the next `limit` versions in; call about once a minute until finished
 *   revert&limit=2000      pauses the job and restores pre-finalize counts; after it, finalize refuses
 *   pause / resume         the job's brake
 *   recount&ids=1,2        sets named versions to a fresh count
 * A version merge while finalize runs can add a source's frozen count onto a target finalize
 * already passed (mergeModelVersions sums imageCount): recount the targets of any merge made
 * between finalize's first and last call. Such a merge can also leave the target's rollback point
 * holding the source's old value, so do not revert across one without checking those targets.
 */
const schema = z.object({
  mode: z.enum(['status', 'start', 'stage', 'finalize', 'revert', 'pause', 'resume', 'recount']),
  dryRun: booleanString().default(true),
  start: z.coerce.number().int().min(1).optional(),
  end: z.coerce.number().int().min(1).optional(),
  batchSize: z.coerce.number().int().min(1000).max(500_000).default(100_000),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
  limit: z.coerce.number().int().min(1).max(10_000).default(2000),
  ids: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .pipe(z.array(z.number().int().positive()).min(1).max(100))
    .optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  switch (params.mode) {
    case 'status':
      return res.status(200).json(await backfillStatus());
    case 'start':
      return res.status(200).json(await startBackfill());
    case 'stage': {
      if (!params.start || !params.end)
        return res.status(400).json({ error: 'start and end required' });
      const result = await stageRange({
        start: params.start,
        end: params.end,
        batchSize: params.batchSize,
        concurrency: params.concurrency,
        dryRun: params.dryRun,
        runContext: res,
      });
      return res.status(200).json({ dryRun: params.dryRun, ...result });
    }
    case 'finalize':
      return res.status(200).json(await finalizeBatch(params.limit));
    case 'revert':
      return res.status(200).json(await revertBatch(params.limit));
    case 'pause':
      return res.status(200).json(await setPaused(true));
    case 'resume':
      return res.status(200).json(await setPaused(false));
    case 'recount':
      if (!params.ids) return res.status(400).json({ error: 'ids required' });
      return res.status(200).json(await recountVersions(params.ids));
  }
});
