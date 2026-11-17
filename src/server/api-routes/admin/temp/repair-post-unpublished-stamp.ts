/**
 * One-time repair of posts that carry `metadata.unpublishedAt` while `publishedAt` is still
 * set, so that `publishedAt` alone says whether a post is published.
 *
 * Why an endpoint instead of raw SQL: a change of publish state has to queue the affected
 * images and models for reindexing and refresh the caches derived from it.
 *
 * Every candidate goes in the first bucket that fits (src/server/utils/post-unpublished-stamp-repair.ts):
 *
 *   parentDown   the owner's post under a moderator takedown (checked first), or on a version
 *                that is not Published (checked last). Always `clear`.
 *   scheduled    publishedAt is in the future. `scheduled` = strip (default) | skip | clear.
 *   liveParent   the owner's post on a Published version under a Published model.
 *                `liveParent` = strip (default) | skip.
 *   halfLive     the owner's post on a Published version under a model that is not.
 *                `halfLive` = strip (default) | skip | clear.
 *   ownerEdited  stamped by the owner before publishedAt, and written to more than 5 s after
 *                the stamp. `ownerEdited` = strip (default) | skip | clear.
 *   detached     no version, or not the model owner's post. Always `clear`.
 *
 *   clear  publishedAt = NULL, keeping the date in `prevPublishedAt` when the post has none,
 *          so a later republish restores it. Refused for a post whose parent is live.
 *   strip  drop `unpublishedAt` and `unpublishedBy`.
 *
 * Actions:
 *   action=apply (default)  repair, stashing every overwritten value under `repair*` keys
 *   action=rollback         restore cleared posts from the stash. Stripped posts are restored
 *                           only when named in `postIds`: nothing in the row tells a stripped
 *                           post from one unpublished and republished since.
 *   action=resync           no Post write: re-run the reindex and cache refresh for the rows
 *                           that carry a stash
 *   action=cleanup          drop the stash. Rollback is not possible afterwards.
 *
 * `dryRun=true` (the default) writes nothing and reports what the run would do.
 *
 * Writes go `batchSize` posts per statement with `pauseMs` between them, and each batch is
 * reindexed before the next starts. A run that stops part-way leaves the finished batches
 * repaired; run the same action again for the rest.
 *
 * Run with:
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&postIds=<id>,<id>
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false&action=rollback
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false&action=cleanup
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { userImageVideoCountCaches, userPostCountCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import {
  deleteImagesForModelVersionCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  BUCKETS,
  planRepair,
  type Bucket,
  type StampedPostRow,
} from '~/server/utils/post-unpublished-stamp-repair';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

const overridableAction = z.enum(['strip', 'skip', 'clear']).default('strip');
const schema = z.object({
  dryRun: booleanString().default(true),
  action: z.enum(['apply', 'rollback', 'resync', 'cleanup']).default('apply'),
  liveParent: z.enum(['strip', 'skip']).default('strip'),
  scheduled: overridableAction,
  halfLive: overridableAction,
  ownerEdited: overridableAction,
  postIds: commaDelimitedNumberArray(z.array(z.number().int().positive())).default([]),
  batchSize: z.coerce.number().int().min(1).max(1000).default(200),
  pauseMs: z.coerce.number().int().min(0).max(10_000).default(250),
});

const SAMPLE_SIZE = 5;
const TAG = '[repair-post-unpublished-stamp]';

/** `hidden`: after the statement, other users cannot see the post's images. A stamp hides them
 * even with `publishedAt` set, which is why both restores return true. */
type Touched = { id: number; modelVersionId: number | null; userId: number; hidden: boolean };
type Stashed = Touched & { stripped: boolean };
type Batching = { batchSize: number; pauseMs: number };
type Statement = (ids: number[]) => Prisma.Sql;
type SideEffects = { imagesRemoved: number; imagesReindexed: number; modelsReindexed: number };
type Progress = { sideEffects: SideEffects; sideEffectFailures: number; committed: number };

/** A batch failed; `progress` is what committed before it, possibly nothing. */
class PartialRun extends Error {
  constructor(public readonly progress: Progress, public readonly cause: unknown) {
    super('partial run');
  }
}

const scopeTo = (postIds: number[]) =>
  postIds.length ? Prisma.sql`AND p.id = ANY(${postIds}::int[])` : Prisma.empty;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parentIsLive = Prisma.sql`
  EXISTS (
    SELECT 1
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv.id = p."modelVersionId"
      AND mv.status = 'Published'
      AND m.status = 'Published'
  )
`;

const clearPublishedAt: Statement = (ids) => Prisma.sql`
  UPDATE "Post" p
  SET
    metadata = p.metadata
      || jsonb_build_object(
           'repairPrevPublishedAt', p."publishedAt",
           'repairStampAt', p.metadata->'unpublishedAt'
         )
      || CASE
           WHEN p.metadata->>'prevPublishedAt' IS NULL
           THEN jsonb_build_object(
             'prevPublishedAt', p."publishedAt",
             'repairAddedPrevPublishedAt', true
           )
           ELSE '{}'::jsonb
         END,
    "publishedAt" = NULL
  WHERE p.id = ANY(${ids}::int[])
    AND p."publishedAt" IS NOT NULL
    AND p.metadata->>'unpublishedAt' IS NOT NULL
    AND NOT ${parentIsLive}
  RETURNING p.id, p."modelVersionId", p."userId", true AS hidden
`;

const stripStamp =
  (requireLiveParent: boolean): Statement =>
  (ids) =>
    Prisma.sql`
      UPDATE "Post" p
      SET
        metadata = (
          p.metadata
            || jsonb_build_object('repairPrevUnpublishedAt', p.metadata->'unpublishedAt')
            || CASE
                 WHEN p.metadata->'unpublishedBy' IS NOT NULL
                 THEN jsonb_build_object('repairPrevUnpublishedBy', p.metadata->'unpublishedBy')
                 ELSE '{}'::jsonb
               END
        ) - 'unpublishedAt' - 'unpublishedBy'
      WHERE p.id = ANY(${ids}::int[])
        AND p."publishedAt" IS NOT NULL
        AND p.metadata->>'unpublishedAt' IS NOT NULL
        ${requireLiveParent ? Prisma.sql`AND ${parentIsLive}` : Prisma.empty}
      RETURNING p.id, p."modelVersionId", p."userId", false AS hidden
    `;

// A stamp other than the stashed one is a newer unpublish; the stash must not overwrite it.
const restorePublishedAt: Statement = (ids) => Prisma.sql`
  UPDATE "Post" p
  SET
    "publishedAt" = (p.metadata->>'repairPrevPublishedAt')::timestamp,
    metadata = (
      CASE
        WHEN p.metadata->>'repairAddedPrevPublishedAt' IS NOT NULL
        THEN p.metadata - 'prevPublishedAt'
        ELSE p.metadata
      END
    ) - 'repairPrevPublishedAt' - 'repairAddedPrevPublishedAt' - 'repairStampAt'
  WHERE p.id = ANY(${ids}::int[])
    AND p.metadata->>'repairPrevPublishedAt' IS NOT NULL
    AND p."publishedAt" IS NULL
    AND p.metadata->'unpublishedAt' = p.metadata->'repairStampAt'
  RETURNING p.id, p."modelVersionId", p."userId", true AS hidden
`;

const restoreStamp: Statement = (ids) => Prisma.sql`
  UPDATE "Post" p
  SET
    metadata = (
      p.metadata
        || jsonb_build_object('unpublishedAt', p.metadata->'repairPrevUnpublishedAt')
        || CASE
             WHEN p.metadata->'repairPrevUnpublishedBy' IS NOT NULL
             THEN jsonb_build_object('unpublishedBy', p.metadata->'repairPrevUnpublishedBy')
             ELSE '{}'::jsonb
           END
    ) - 'repairPrevUnpublishedAt' - 'repairPrevUnpublishedBy'
  WHERE p.id = ANY(${ids}::int[])
    AND p.metadata->>'repairPrevUnpublishedAt' IS NOT NULL
    AND p."publishedAt" IS NOT NULL
    AND p.metadata->>'unpublishedAt' IS NULL
  RETURNING p.id, p."modelVersionId", p."userId", true AS hidden
`;

const dropStash: Statement = (ids) => Prisma.sql`
  UPDATE "Post" p
  SET
    metadata = p.metadata
      - 'repairPrevPublishedAt'
      - 'repairAddedPrevPublishedAt'
      - 'repairStampAt'
      - 'repairPrevUnpublishedAt'
      - 'repairPrevUnpublishedBy'
  WHERE p.id = ANY(${ids}::int[])
    AND (p.metadata->>'repairPrevPublishedAt' IS NOT NULL
      OR p.metadata->>'repairPrevUnpublishedAt' IS NOT NULL)
  RETURNING p.id, p."modelVersionId", p."userId", false AS hidden
`;

async function runSideEffects(touched: Touched[]): Promise<SideEffects> {
  const hiddenPostIds = new Set(touched.filter((p) => p.hidden).map((p) => p.id));
  const images = await dbWrite.image.findMany({
    where: { postId: { in: touched.map((p) => p.id) } },
    select: { id: true, postId: true },
  });
  const removed = images.filter((i) => i.postId != null && hiddenPostIds.has(i.postId));
  const reindexed = images.filter((i) => i.postId == null || !hiddenPostIds.has(i.postId));
  if (removed.length)
    await queueImageSearchIndexUpdate({
      ids: removed.map((i) => i.id),
      action: SearchIndexUpdateQueueAction.Delete,
    });
  if (reindexed.length)
    await queueImageSearchIndexUpdate({
      ids: reindexed.map((i) => i.id),
      action: SearchIndexUpdateQueueAction.Update,
    });

  const versionIds = [
    ...new Set(touched.map((p) => p.modelVersionId).filter((id): id is number => id != null)),
  ];
  let modelsReindexed = 0;
  if (versionIds.length) {
    await deleteImagesForModelVersionCache(versionIds);
    const versions = await dbWrite.modelVersion.findMany({
      where: { id: { in: versionIds } },
      select: { modelId: true },
    });
    const modelIds = [...new Set(versions.map((v) => v.modelId))];
    if (modelIds.length)
      await modelsSearchIndex.queueUpdate(
        modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    modelsReindexed = modelIds.length;
  }

  const userIds = [...new Set(touched.map((p) => p.userId))];
  await userPostCountCache.refresh(userIds);
  await userImageVideoCountCaches.refresh(userIds);

  return { imagesRemoved: removed.length, imagesReindexed: reindexed.length, modelsReindexed };
}

const newProgress = (): Progress => ({
  sideEffects: { imagesRemoved: 0, imagesReindexed: 0, modelsReindexed: 0 },
  sideEffectFailures: 0,
  committed: 0,
});

async function reindex(touched: Touched[], progress: Progress, label: string) {
  if (!touched.length) return;
  try {
    const done = await runSideEffects(touched);
    progress.sideEffects.imagesRemoved += done.imagesRemoved;
    progress.sideEffects.imagesReindexed += done.imagesReindexed;
    progress.sideEffects.modelsReindexed += done.modelsReindexed;
  } catch (error) {
    progress.sideEffectFailures += 1;
    console.error(`${TAG} ${label} side effects failed for ${touched.length} posts`, error);
  }
}

async function runInBatches(
  work: { label: string; ids: number[]; statement: Statement; reindexes?: boolean }[],
  { batchSize, pauseMs }: Batching,
  progress: Progress
): Promise<number[]> {
  const perStatement: number[] = [];
  for (const { label, ids, statement, reindexes = true } of work) {
    let written = 0;
    const batches = chunk(ids, batchSize);
    for (const [index, batch] of batches.entries()) {
      let rows: Touched[];
      try {
        rows = await dbWrite.$queryRaw<Touched[]>(statement(batch));
      } catch (error) {
        throw new PartialRun(progress, error);
      }
      written += rows.length;
      progress.committed += rows.length;
      if (reindexes) await reindex(rows, progress, label);
      console.log(
        `${TAG} ${label} batch ${index + 1}/${batches.length} wrote ${rows.length} of ${
          batch.length
        } (ids ${batch[0]}..${batch[batch.length - 1]})`
      );
      if (pauseMs) await sleep(pauseMs);
    }
    perStatement.push(written);
  }
  return perStatement;
}

async function findCandidates(postIds: number[]) {
  return dbWrite.$queryRaw<StampedPostRow[]>`
    SELECT
      p.id,
      p."publishedAt",
      (p.metadata->>'unpublishedAt')::timestamptz AS "unpublishedAt",
      p."updatedAt",
      p."userId",
      COALESCE(p.metadata->>'unpublishedBy' = p."userId"::text, false) AS "stampedByOwner",
      p."modelVersionId",
      mv.status::text AS "versionStatus",
      m.status::text AS "modelStatus",
      m."userId" AS "modelUserId"
    FROM "Post" p
    LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE p.metadata->>'unpublishedAt' IS NOT NULL
      AND p."publishedAt" IS NOT NULL
      ${scopeTo(postIds)}
  `;
}

async function findStashed(postIds: number[]) {
  return dbWrite.$queryRaw<Stashed[]>`
    SELECT
      p.id,
      p."modelVersionId",
      p."userId",
      (p."publishedAt" IS NULL OR p.metadata->>'unpublishedAt' IS NOT NULL) AS hidden,
      p.metadata->>'repairPrevUnpublishedAt' IS NOT NULL AS stripped
    FROM "Post" p
    WHERE (p.metadata->>'repairPrevPublishedAt' IS NOT NULL
        OR p.metadata->>'repairPrevUnpublishedAt' IS NOT NULL)
      ${scopeTo(postIds)}
  `;
}

type Params = z.infer<typeof schema>;

async function runApply(params: Params, progress: Progress) {
  const { dryRun, postIds, liveParent, scheduled, halfLive, ownerEdited } = params;
  const rows = await findCandidates(postIds);
  const plan = planRepair(rows, { liveParent, scheduled, halfLive, ownerEdited }, new Date());
  const planned = {
    candidates: rows.length,
    buckets: Object.fromEntries(
      BUCKETS.map((bucket: Bucket) => [
        bucket,
        { posts: plan.buckets[bucket].length, sample: plan.buckets[bucket].slice(0, SAMPLE_SIZE) },
      ])
    ),
    planned: {
      clear: plan.clear.length,
      strip: plan.stripLive.length + plan.stripForced.length,
      skip: plan.skipped.length,
    },
  };
  if (dryRun) return planned;

  const [cleared, strippedLive, strippedForced] = await runInBatches(
    [
      { label: 'clear', ids: plan.clear, statement: clearPublishedAt },
      { label: 'strip', ids: plan.stripLive, statement: stripStamp(true) },
      { label: 'strip-forced', ids: plan.stripForced, statement: stripStamp(false) },
    ],
    params,
    progress
  );
  const stripped = strippedLive + strippedForced;
  return {
    ...planned,
    ops: {
      clearedPublishedAt: cleared,
      strippedStamp: stripped,
      changedSincePlan: planned.planned.clear + planned.planned.strip - cleared - stripped,
    },
  };
}

async function runRollback({ dryRun, postIds, ...batching }: Params, progress: Progress) {
  const stashed = await findStashed(postIds);
  const cleared = stashed.filter((p) => !p.stripped).map((p) => p.id);
  // Restorable only when named: the row cannot tell a stripped post from one republished since.
  const stripped = stashed.filter((p) => p.stripped).map((p) => p.id);
  const restorable = postIds.length ? stripped : [];
  const found = {
    stashed: stashed.length,
    cleared: cleared.length,
    stripped: stripped.length,
    strippedLeftForPostIds: stripped.length - restorable.length,
  };
  if (dryRun) return found;

  const [restoredPublishedAt, restoredStamp] = await runInBatches(
    [
      { label: 'restore-published-at', ids: cleared, statement: restorePublishedAt },
      { label: 'restore-stamp', ids: restorable, statement: restoreStamp },
    ],
    batching,
    progress
  );
  return {
    ...found,
    ops: {
      restoredPublishedAt,
      restoredStamp,
      changedSinceApply: cleared.length + restorable.length - restoredPublishedAt - restoredStamp,
    },
  };
}

async function runResync({ dryRun, postIds, batchSize }: Params, progress: Progress) {
  const stashed = await findStashed(postIds);
  if (!dryRun)
    for (const batch of chunk(stashed, batchSize)) await reindex(batch, progress, 'resync');
  return { stashed: stashed.length };
}

async function runCleanup({ dryRun, postIds, ...batching }: Params, progress: Progress) {
  const ids = (await findStashed(postIds)).map((p) => p.id);
  if (dryRun) return { stashed: ids.length };
  const [dropped] = await runInBatches(
    [{ label: 'cleanup', ids, statement: dropStash, reindexes: false }],
    batching,
    progress
  );
  return { stashed: ids.length, ops: { stashDropped: dropped } };
}

const RUN = { apply: runApply, rollback: runRollback, resync: runResync, cleanup: runCleanup };

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
  const params = parsed.data;
  const { action, dryRun, postIds } = params;
  const scope = postIds.length ? `${postIds.length} posts` : 'global';
  console.log(`${TAG} action=${action} dryRun=${dryRun} scope=${scope} starting`);

  const progress = newProgress();
  try {
    const summary = await RUN[action](params, progress);
    if (dryRun) return res.status(200).json({ action, dryRun, ...summary });

    console.log(`${TAG} action=${action} finished, wrote ${progress.committed} posts`);
    const { sideEffects, sideEffectFailures } = progress;
    if (!sideEffectFailures)
      return res.status(200).json({ action, dryRun, ...summary, sideEffects });
    return res.status(500).json({
      action,
      dryRun,
      ...summary,
      sideEffects,
      sideEffectFailures,
      error: 'committed, but some side effects failed; re-run with action=resync',
    });
  } catch (error) {
    if (!(error instanceof PartialRun) || !error.progress.committed) {
      const cause = error instanceof PartialRun ? error.cause : error;
      console.error(`${TAG} action=${action} failed, nothing committed`, cause);
      return handleEndpointError(res, cause);
    }
    console.error(`${TAG} action=${action} stopped part-way`, error.cause);
    return res.status(500).json({
      action,
      dryRun,
      committedPosts: error.progress.committed,
      sideEffects: error.progress.sideEffects,
      sideEffectFailures: error.progress.sideEffectFailures,
      error: `stopped part-way; run action=${action} again for the rest`,
    });
  }
});
