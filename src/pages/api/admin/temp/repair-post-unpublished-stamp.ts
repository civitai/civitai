/**
 * One-time repair of posts that carry `metadata.unpublishedAt` while `publishedAt` is still
 * set. The image hydrate treats such a post as unpublished; everything that reads only
 * `publishedAt` treats it as published, so the two disagree about the same post.
 *
 * Why an endpoint instead of raw SQL: a change of publish state has to queue the affected
 * images and models for reindexing and evict the per-version image cache, or the search
 * index and cached reads keep the old state.
 *
 * Every candidate is put in exactly one bucket (src/server/utils/post-unpublished-stamp-repair.ts):
 *
 *   orphan       unpublishedAt > publishedAt, parent version or model is not Published.
 *                Action `clear`: publishedAt = NULL, the state an unpublish leaves today.
 *   republished  unpublishedAt < publishedAt. Action `strip`: drop unpublishedAt and
 *                unpublishedBy, the state a republish leaves today.
 *   liveParent   unpublishedAt > publishedAt, but the parent version and model are both
 *                Published. Action from `liveParent` (default `skip`).
 *   detached     unpublishedAt > publishedAt, not the model owner's post on a version.
 *                Action from `detached` (default `skip`).
 *   equal        the two timestamps are identical. Never touched.
 *
 * `clear` also writes `prevPublishedAt` when the post has none, so a later republish restores
 * the original date instead of moving the post to the top of the feeds.
 *
 * Writes are committed `batchSize` posts at a time with `pauseMs` between commits, never as
 * one transaction: every row is replayed by logical-replication subscribers, and one
 * transaction over the whole set can outlast their apply timeout and stall them. A run that
 * stops part-way leaves the committed batches repaired; run the same action again for the rest.
 *
 * Actions:
 *   action=apply (default)  repair, stashing every overwritten value under `repairPrev*`
 *   action=rollback         restore from the stash; a row that changed since is left alone
 *                           and counted under `changedSinceApply`
 *   action=resync           no Post write: re-run the reindex and cache eviction for the
 *                           rows that carry a stash
 *
 * `dryRun=true` (the default) runs every batch in a transaction and aborts it; the response
 * carries the counts the real run would produce and up to five sample ids per bucket.
 *
 * Run with:
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=true
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=true&postIds=<id>,<id>
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false&liveParent=strip
 *   POST /api/admin/temp/repair-post-unpublished-stamp?token=$WEBHOOK_TOKEN&dryRun=false&action=rollback
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
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

const undecidedAction = z.enum(['skip', 'strip', 'clear']).default('skip');
const schema = z.object({
  dryRun: booleanString().default(true),
  action: z.enum(['apply', 'rollback', 'resync']).default('apply'),
  liveParent: undecidedAction,
  detached: undecidedAction,
  postIds: commaDelimitedNumberArray(z.array(z.number().int().positive())).default([]),
  batchSize: z.coerce.number().int().min(1).max(1000).default(200),
  pauseMs: z.coerce.number().int().min(0).max(10_000).default(250),
});

const SAMPLE_SIZE = 5;

type Touched = { id: number; modelVersionId: number | null };
type Batching = { dryRun: boolean; batchSize: number; pauseMs: number };
type Statement = (ids: number[]) => Prisma.Sql;

class DryRunAbort extends Error {
  constructor(public readonly rows: Touched[]) {
    super('dry run');
  }
}

/** Thrown when a batch fails after earlier ones committed, so the caller can still reindex them. */
class PartialRun extends Error {
  constructor(public readonly committed: Touched[], public readonly cause: unknown) {
    super('partial run');
  }
}

const scopeTo = (postIds: number[]) =>
  postIds.length ? Prisma.sql`AND p.id = ANY(${postIds}::int[])` : Prisma.empty;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runBatch(statement: Prisma.Sql, dryRun: boolean): Promise<Touched[]> {
  try {
    return await dbWrite.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Touched[]>(statement);
      if (dryRun) throw new DryRunAbort(rows);
      return rows;
    });
  } catch (error) {
    if (error instanceof DryRunAbort) return error.rows;
    throw error;
  }
}

async function runInBatches(
  work: { ids: number[]; statement: Statement }[],
  { dryRun, batchSize, pauseMs }: Batching
): Promise<Touched[][]> {
  const committed: Touched[] = [];
  const perStatement: Touched[][] = [];
  for (const { ids, statement } of work) {
    const touched: Touched[] = [];
    for (const batch of chunk(ids, batchSize)) {
      try {
        const rows = await runBatch(statement(batch), dryRun);
        touched.push(...rows);
        if (!dryRun) committed.push(...rows);
      } catch (error) {
        throw new PartialRun(committed, error);
      }
      if (pauseMs && !dryRun) await sleep(pauseMs);
    }
    perStatement.push(touched);
  }
  return perStatement;
}

const clearPublishedAt: Statement = (ids) => Prisma.sql`
  UPDATE "Post" p
  SET
    metadata = p.metadata
      || jsonb_build_object('repairPrevPublishedAt', p."publishedAt")
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
  RETURNING p.id, p."modelVersionId"
`;

const stripStamp: Statement = (ids) => Prisma.sql`
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
  RETURNING p.id, p."modelVersionId"
`;

// Both restores touch only rows still in the state apply left them in: a post republished or
// unpublished since holds a newer decision than the stash.
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
    ) - 'repairPrevPublishedAt' - 'repairAddedPrevPublishedAt'
  WHERE p.id = ANY(${ids}::int[])
    AND p.metadata->>'repairPrevPublishedAt' IS NOT NULL
    AND p."publishedAt" IS NULL
    AND p.metadata->>'unpublishedAt' IS NOT NULL
  RETURNING p.id, p."modelVersionId"
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
  RETURNING p.id, p."modelVersionId"
`;

type Result = { summary: Record<string, unknown>; touched: Touched[] };

async function runApply(
  postIds: number[],
  undecided: Parameters<typeof planRepair>[1],
  batching: Batching
): Promise<Result> {
  const rows = await dbWrite.$queryRaw<StampedPostRow[]>`
    SELECT
      p.id,
      p."publishedAt",
      (p.metadata->>'unpublishedAt')::timestamptz AS "unpublishedAt",
      p."userId",
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
  const plan = planRepair(rows, undecided);
  const [cleared, stripped] = await runInBatches(
    [
      { ids: plan.clear, statement: clearPublishedAt },
      { ids: plan.strip, statement: stripStamp },
    ],
    batching
  );

  const buckets = Object.fromEntries(
    BUCKETS.map((bucket: Bucket) => [
      bucket,
      { posts: plan.buckets[bucket].length, sample: plan.buckets[bucket].slice(0, SAMPLE_SIZE) },
    ])
  );
  return {
    summary: {
      candidates: rows.length,
      buckets,
      ops: {
        clearedPublishedAt: cleared.length,
        strippedStamp: stripped.length,
        skipped: plan.skipped.length,
      },
    },
    touched: [...cleared, ...stripped],
  };
}

async function findStashed(postIds: number[]): Promise<Touched[]> {
  return dbWrite.$queryRaw<Touched[]>`
    SELECT p.id, p."modelVersionId"
    FROM "Post" p
    WHERE (p.metadata->>'repairPrevPublishedAt' IS NOT NULL
        OR p.metadata->>'repairPrevUnpublishedAt' IS NOT NULL)
      ${scopeTo(postIds)}
  `;
}

async function runRollback(postIds: number[], batching: Batching): Promise<Result> {
  const ids = (await findStashed(postIds)).map((p) => p.id);
  const [restoredPublishedAt, restoredStamp] = await runInBatches(
    [
      { ids, statement: restorePublishedAt },
      { ids, statement: restoreStamp },
    ],
    batching
  );
  const touched = [...restoredPublishedAt, ...restoredStamp];
  return {
    summary: {
      stashed: ids.length,
      ops: {
        restoredPublishedAt: restoredPublishedAt.length,
        restoredStamp: restoredStamp.length,
        changedSinceApply: ids.length - touched.length,
      },
    },
    touched,
  };
}

async function runSideEffects(touched: Touched[]) {
  let imagesReindexed = 0;
  for (const batch of chunk(touched, 500)) {
    const images = await dbWrite.image.findMany({
      where: { postId: { in: batch.map((p) => p.id) } },
      select: { id: true },
    });
    if (!images.length) continue;
    await queueImageSearchIndexUpdate({
      ids: images.map((i) => i.id),
      action: SearchIndexUpdateQueueAction.Update,
    });
    imagesReindexed += images.length;
  }

  const versionIds = [
    ...new Set(touched.map((p) => p.modelVersionId).filter((id): id is number => id != null)),
  ];
  const modelIds = new Set<number>();
  for (const batch of chunk(versionIds, 1000)) {
    await deleteImagesForModelVersionCache(batch);
    const versions = await dbWrite.modelVersion.findMany({
      where: { id: { in: batch } },
      select: { modelId: true },
    });
    for (const v of versions) modelIds.add(v.modelId);
  }
  for (const batch of chunk([...modelIds], 1000))
    await modelsSearchIndex.queueUpdate(
      batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );

  return {
    imagesReindexed,
    versionCachesEvicted: versionIds.length,
    modelsReindexed: modelIds.size,
  };
}

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
  const { dryRun, action, postIds, liveParent, detached, batchSize, pauseMs } = parsed.data;
  const batching = { dryRun, batchSize, pauseMs };
  const tag = `[repair-post-unpublished-stamp] action=${action} dryRun=${dryRun}`;
  console.log(`${tag} scope=${postIds.length ? `${postIds.length} posts` : 'global'} starting`);

  let result: Result;
  try {
    if (action === 'resync') {
      const touched = await findStashed(postIds);
      result = { summary: { stashed: touched.length }, touched };
    } else {
      result =
        action === 'apply'
          ? await runApply(postIds, { liveParent, detached }, batching)
          : await runRollback(postIds, batching);
    }
  } catch (error) {
    if (!(error instanceof PartialRun) || !error.committed.length) {
      const cause = error instanceof PartialRun ? error.cause : error;
      console.error(`${tag} failed, nothing committed`, cause);
      return handleEndpointError(res, cause);
    }
    console.error(`${tag} stopped after ${error.committed.length} posts`, error.cause);
    // The committed batches are repaired rows like any other; a rollback has already dropped
    // their stash, so this is the only pass that can still find them.
    const sideEffects = await runSideEffects(error.committed).catch((e) => {
      console.error(`${tag} side effects failed after a partial run`, e);
      return null;
    });
    return res.status(500).json({
      action,
      dryRun,
      committedPosts: error.committed.length,
      sideEffects,
      error: `stopped part-way; run action=${action} again for the rest`,
    });
  }

  if (dryRun) return res.status(200).json({ action, dryRun, ...result.summary });

  console.log(`${tag} committed posts=${result.touched.length}`);
  try {
    const sideEffects = await runSideEffects(result.touched);
    return res.status(200).json({ action, dryRun, ...result.summary, sideEffects });
  } catch (error) {
    console.error(`${tag} side effects failed after commit`, error);
    return res.status(500).json({
      action,
      dryRun,
      ...result.summary,
      error: 'committed, but side effects failed; re-run with action=resync',
    });
  }
});
