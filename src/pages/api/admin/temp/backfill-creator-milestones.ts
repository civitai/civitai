import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import type { MilestoneBatchResult } from '~/server/services/creator-milestone-grant.service';
import {
  backfillScoreTierBatch,
  grantMilestoneCosmeticsBatch,
  SYSTEM_USER_ID,
} from '~/server/services/creator-milestone-grant.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Creator Journey score tiers: one-time silent backfill, and cosmetic grants for existing holders.
 *
 * Actions (`?action=`):
 *   tiers      (default) Grant every score tier a user's stored total has reached. Rows are stamped
 *              seen and nothing is notified. Safe to re-run; it also reconciles anyone a failed
 *              nightly grant missed.
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
 *   GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&dryRun=false
 *   GET /api/admin/temp/backfill-creator-milestones?token=$WEBHOOK_TOKEN&action=cosmetics&dryRun=false
 */

const schema = z.object({
  action: z.enum(['tiers', 'cosmetics']).default('tiers'),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().int().min(1).max(5000).default(4000),
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(1).optional(),
  milestoneKey: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const params = schema.parse(req.query);

  if (params.dryRun) {
    const preview = await previewBackfill(params);
    return res.status(200).json({ ...params, ...preview });
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
      // Every committed batch stays committed, so resume with `start` set to this `lastUserId`.
      return res.status(500).json({
        action: params.action,
        error: (e as Error).message,
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

async function previewBackfill(params: z.infer<typeof schema>) {
  const query =
    params.action === 'cosmetics'
      ? `
        SELECT count(DISTINCT ucm."userId")::int AS users, count(*)::int AS rows
        FROM "UserCreatorMilestone" ucm
        JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
        WHERE m."cosmeticId" IS NOT NULL
          AND ($3::text IS NULL OR m.key = $3)
          AND ucm."userId" > $1 AND ($2::int IS NULL OR ucm."userId" <= $2)
          AND NOT EXISTS (
            SELECT 1 FROM "UserCosmetic" uc
            WHERE uc."userId" = ucm."userId" AND uc."cosmeticId" = m."cosmeticId" AND uc."claimKey" = m.key
          )
      `
      : `
        SELECT count(DISTINCT u.id)::int AS users, count(*)::int AS rows
        FROM "User" u
        JOIN "CreatorMilestone" m
          ON m.track = 'score' AND m.threshold IS NOT NULL
          AND (u.meta->'scores'->>'total')::numeric >= m.threshold
        WHERE u.id > $1 AND ($2::int IS NULL OR u.id <= $2) AND u.id <> ${SYSTEM_USER_ID}
          AND NOT EXISTS (
            SELECT 1 FROM "UserCreatorMilestone" ucm
            WHERE ucm."userId" = u.id AND ucm."milestoneKey" = m.key
          )
      `;
  const binds: unknown[] = [params.start, params.end ?? null];
  if (params.action === 'cosmetics') binds.push(params.milestoneKey ?? null);
  const result = await pgDbReadLong.query<{ users: number; rows: number }>(query, binds);
  return { wouldGrant: result.rows[0] };
}
