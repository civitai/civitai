import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import type { MilestoneBatchResult } from '~/server/services/creator-milestone-grant.service';
import {
  backfillScoreTierBatch,
  grantMilestoneCosmeticsBatch,
  previewMilestoneCosmetics,
  previewScoreTierBackfill,
} from '~/server/services/creator-milestone-grant.service';
import {
  CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG,
  isCreatorJourneyPublic,
} from '~/server/services/creator-journey-flag.service';
import { previewActivityGrants } from '~/server/services/creator-milestone-activity.service';
import { activityDetectorGroups } from '~/server/services/creator-milestone-detectors';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Creator Journey score tiers: one-time silent backfill, and cosmetic grants for existing holders.
 *
 * Actions (`?action=`):
 *   tiers      (default) Grant every score tier a user's stored total has reached. Rows are stamped
 *              seen and nothing is notified. Safe to re-run; it also reconciles anyone a failed
 *              nightly grant missed. Refuses to write while the creator-journey flag is not public
 *              (see CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG); the dry run always works.
 *   activity   Dry run only: users and rows per activity detector group that an ungated
 *              grant-creator-milestones run would grant now. That job does the writing.
 *   cosmetics  After a cosmetic is attached to a milestone definition, grant it to that milestone's
 *              existing holders. Optional `&milestoneKey=score:flame` limits it to one definition.
 *
 * Params:
 *   dryRun     default true: counts what would be granted, on the long-read pool, and writes nothing.
 *   batchSize  users per statement, default 4000. Each statement commits on its own, and a user's
 *              rows are never split across two, so a batch writes at most 9 x batchSize rows.
 *   start      resume after this userId (the `lastUserId` a previous run returned). Default 0.
 *   end        stop at this userId, inclusive.
 *
 * Order: tiers, then ANALYZE "UserCreatorMilestone" and EXPLAIN the cosmetics batch, then cosmetics.
 *
 *   GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&dryRun=false
 *   GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&action=cosmetics&dryRun=false
 */

const schema = z.object({
  action: z.enum(['tiers', 'cosmetics', 'activity']).default('tiers'),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().int().min(1).max(5000).default(4000),
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(1).optional(),
  milestoneKey: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const params = schema.parse(req.query);

  if (params.action === 'activity') {
    if (!params.dryRun)
      return res.status(400).json({ error: 'The grant-creator-milestones job grants these' });
    const wouldGrant = await previewActivityGrants(pgDbReadLong, activityDetectorGroups());
    return res.status(200).json({ ...params, wouldGrant });
  }

  if (params.dryRun) {
    const wouldGrant = await previewBackfill(params);
    return res.status(200).json({ ...params, wouldGrant });
  }

  if (
    params.action === 'tiers' &&
    CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG &&
    !(await isCreatorJourneyPublic())
  ) {
    return res
      .status(409)
      .json({ error: 'Tier grants wait for the creator-journey flag to be public' });
  }

  const runBatch = (afterUserId: number): Promise<MilestoneBatchResult> =>
    params.action === 'cosmetics'
      ? grantMilestoneCosmeticsBatch(pgDbWrite, {
          afterUserId,
          maxUserId: params.end,
          limit: params.batchSize,
          milestoneKey: params.milestoneKey,
        })
      : backfillScoreTierBatch(pgDbWrite, {
          afterUserId,
          maxUserId: params.end,
          limit: params.batchSize,
        });

  let cursor = params.start;
  let batches = 0;
  let users = 0;
  let inserted = 0;
  for (;;) {
    let batch: MilestoneBatchResult;
    try {
      batch = await runBatch(cursor);
    } catch (e) {
      console.error(`backfill-creator-milestones ${params.action}: batch after user ${cursor}`, e);
      // Every committed batch stays committed, so resume with `start` set to this `lastUserId`.
      return res.status(500).json({
        action: params.action,
        error: 'Batch failed; see server logs',
        batches,
        users,
        inserted,
        lastUserId: cursor,
      });
    }
    if (!batch.users || batch.lastUserId == null) break;
    batches++;
    users += batch.users;
    inserted += batch.inserted;
    cursor = batch.lastUserId;
    console.log(
      `backfill-creator-milestones ${params.action}: batch ${batches}, through user ${cursor}, ${inserted} rows`
    );
  }

  return res
    .status(200)
    .json({ action: params.action, batches, users, inserted, lastUserId: cursor });
});

function previewBackfill(params: z.infer<typeof schema>) {
  const range = { afterUserId: params.start, maxUserId: params.end };
  return params.action === 'cosmetics'
    ? previewMilestoneCosmetics(pgDbReadLong, { ...range, milestoneKey: params.milestoneKey })
    : previewScoreTierBackfill(pgDbReadLong, range);
}
