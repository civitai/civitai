/**
 * One-time endpoint to clamp ModelVersion.publishedAt, Model.publishedAt,
 * Model.lastVersionAt, and Post.publishedAt where prior republishes bumped
 * them past their original publish date. Companion to the anti-bump guards
 * added at the publish write sites (see ClickUp 868jne3fd).
 *
 * Why an endpoint instead of a raw SQL migration:
 *   - clamping publishedAt changes the search-index sort keys
 *     (publishedAtUnix on Model + Image docs); without queueing index
 *     updates the Meilisearch entries stay stuck on the bumped values
 *   - dataForModelsCache + bustMvCache need refreshing so feed reads
 *     pick up the new sort order without waiting for TTL
 *   - the raw SQL would otherwise need to also write to the
 *     SearchIndexUpdateQueue table by hand, which is duplicative and
 *     misses cache invalidation entirely
 *
 * Run with:
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=WEBHOOK_TOKEN&dryRun=true
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=WEBHOOK_TOKEN
 *
 * `dryRun=true` runs all SQL inside a transaction then aborts it via thrown
 * sentinel — DB writes roll back, side-effects (search-index queue, cache
 * refresh) are skipped, response includes the same `ops` counts the real
 * run would produce.
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import {
  imagesSearchIndex,
  imagesMetricsSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dataForModelsCache } from '~/server/redis/caches';
import { bustMvCache } from '~/server/services/model-version.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  dryRun: booleanString().default(false),
});

type Ops = {
  clampedVersionsByVersionMeta: number;
  clampedVersionsByPostEvidence: number;
  resyncedModelLastVersionAt: number;
  clampedModelPublishedAt: number;
  clampedPosts: number;
  reclassedVersionsToUnpublished: number;
  reclassedModelsToUnpublished: number;
};

type AffectedIds = {
  modelIds: number[];
  versionIds: number[];
  postIds: number[];
};

class DryRunRollback extends Error {
  constructor(public readonly payload: { ops: Ops; affected: AffectedIds }) {
    super('dry-run rollback');
  }
}

async function runClampTransaction(dryRun: boolean): Promise<{ ops: Ops; affected: AffectedIds }> {
  return dbWrite.$transaction(
    async (tx) => {
      // ---- Snapshot bump-evidence rowsets BEFORE any clamp runs ----
      // Steps 2/2b filter by the same evidence (`meta.unpublishedAt <
      // publishedAt`, `post.publishedAt < mv.publishedAt`) that steps 1a/1b
      // *consume* by clamping. Snapshotting freezes the scope so downstream
      // steps survive the in-transaction mutations. Step 3 (post clamp) is
      // self-contained but we also snapshot its scope so we know which post
      // IDs to queue for image-search reindex after commit.
      await tx.$executeRaw(Prisma.sql`
        CREATE TEMP TABLE op1a_versions ON COMMIT DROP AS
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE "publishedAt" IS NOT NULL
          AND "publishedAt" <= NOW()
          AND status = 'Published'
          AND meta->>'unpublishedAt' IS NOT NULL
          AND (meta->>'unpublishedAt')::timestamptz < "publishedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        CREATE TEMP TABLE op1b_versions ON COMMIT DROP AS
        SELECT DISTINCT mv.id, mv."modelId"
        FROM "ModelVersion" mv
        JOIN "Post" p ON p."modelVersionId" = mv.id
        JOIN "Model" mm ON mm.id = mv."modelId" AND mm."userId" = p."userId"
        WHERE mv.status = 'Published'
          AND mv."publishedAt" IS NOT NULL
          AND mv."publishedAt" <= NOW()
          AND p.metadata->>'unpublishedAt' IS NOT NULL
          AND p."publishedAt" IS NOT NULL
          AND p."publishedAt" < mv."publishedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        CREATE TEMP TABLE op3_posts ON COMMIT DROP AS
        SELECT id
        FROM "Post"
        WHERE metadata->>'prevPublishedAt' IS NOT NULL
          AND "publishedAt" IS NOT NULL
          AND "publishedAt" > (metadata->>'prevPublishedAt')::timestamptz
      `);

      // ---- 1a) clamp ModelVersion.publishedAt via version meta breadcrumb ----
      const clampedVersionsByVersionMeta = await tx.$executeRaw(Prisma.sql`
        UPDATE "ModelVersion"
        SET "publishedAt" = GREATEST(
          "createdAt",
          LEAST(
            "publishedAt",
            (meta->>'unpublishedAt')::timestamptz
          )
        )
        WHERE id IN (SELECT id FROM op1a_versions)
      `);

      // ---- 1b) clamp ModelVersion.publishedAt via owner-post evidence ----
      const clampedVersionsByPostEvidence = await tx.$executeRaw(Prisma.sql`
        UPDATE "ModelVersion" mv
        SET "publishedAt" = GREATEST(
          mv."createdAt",
          LEAST(
            mv."publishedAt",
            (
              SELECT MIN(p."publishedAt")
              FROM "Post" p
              JOIN "Model" m ON m.id = mv."modelId"
              WHERE p."modelVersionId" = mv.id
                AND p."userId" = m."userId"
                AND p.metadata->>'unpublishedAt' IS NOT NULL
                AND p."publishedAt" IS NOT NULL
            )
          )
        )
        WHERE mv.id IN (SELECT id FROM op1b_versions)
      `);

      // ---- 2) resync Model.lastVersionAt for 1a ∪ 1b modelIds ----
      const resyncedModelLastVersionAt = await tx.$executeRaw(Prisma.sql`
        UPDATE "Model" m
        SET "lastVersionAt" = sub.last_pub
        FROM (
          SELECT "modelId", MAX("publishedAt") AS last_pub
          FROM "ModelVersion"
          WHERE status = 'Published'
            AND "publishedAt" IS NOT NULL
            AND "publishedAt" <= NOW()
          GROUP BY "modelId"
        ) sub
        WHERE m.id = sub."modelId"
          AND m."lastVersionAt" IS DISTINCT FROM sub.last_pub
          AND m.id IN (
            SELECT "modelId" FROM op1a_versions
            UNION
            SELECT "modelId" FROM op1b_versions
          )
      `);

      // ---- 2b) clamp Model.publishedAt for 1b modelIds ----
      const clampedModelPublishedAt = await tx.$executeRaw(Prisma.sql`
        UPDATE "Model" m
        SET "publishedAt" = sub.first_pub
        FROM (
          SELECT "modelId", MIN("publishedAt") AS first_pub
          FROM "ModelVersion"
          WHERE status = 'Published'
            AND "publishedAt" IS NOT NULL
            AND "publishedAt" <= NOW()
          GROUP BY "modelId"
        ) sub
        WHERE m.id = sub."modelId"
          AND m."publishedAt" IS NOT NULL
          AND m."publishedAt" > sub.first_pub
          AND m.id IN (SELECT "modelId" FROM op1b_versions)
      `);

      // ---- 3) clamp Post.publishedAt where bumped past prevPublishedAt ----
      const clampedPosts = await tx.$executeRaw(Prisma.sql`
        UPDATE "Post"
        SET "publishedAt" = GREATEST(
          "createdAt",
          LEAST(
            "publishedAt",
            (metadata->>'prevPublishedAt')::timestamptz
          )
        )
        WHERE id IN (SELECT id FROM op3_posts)
      `);

      // ---- 4) reclassify legacy cron-demoted Draft -> Unpublished ----
      const reclassedVersionsToUnpublished = await tx.$executeRaw(Prisma.sql`
        UPDATE "ModelVersion"
        SET status = 'Unpublished'::"ModelStatus"
        WHERE status = 'Draft'::"ModelStatus"
          AND meta->>'unpublishedAt'     IS NOT NULL
          AND meta->>'unpublishedReason' IN ('no-files', 'no-posts')
      `);

      const reclassedModelsToUnpublished = await tx.$executeRaw(Prisma.sql`
        UPDATE "Model" m
        SET status = 'Unpublished'::"ModelStatus"
        WHERE m.status = 'Draft'::"ModelStatus"
          AND m.meta->>'unpublishedAt'     IS NOT NULL
          AND m.meta->>'unpublishedReason' = 'no-versions'
      `);

      // ---- collect affected IDs for side-effects ----
      const affectedVersionRows = await tx.$queryRaw<{ id: number; modelId: number }[]>(Prisma.sql`
        SELECT id, "modelId" FROM op1a_versions
        UNION
        SELECT id, "modelId" FROM op1b_versions
      `);
      const versionIds = affectedVersionRows.map((r) => r.id);
      const versionModelIds = affectedVersionRows.map((r) => r.modelId);

      const postRows = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM op3_posts
      `);

      const modelIds = Array.from(new Set(versionModelIds));
      const postIds = postRows.map((r) => r.id);

      const result = {
        ops: {
          clampedVersionsByVersionMeta: Number(clampedVersionsByVersionMeta),
          clampedVersionsByPostEvidence: Number(clampedVersionsByPostEvidence),
          resyncedModelLastVersionAt: Number(resyncedModelLastVersionAt),
          clampedModelPublishedAt: Number(clampedModelPublishedAt),
          clampedPosts: Number(clampedPosts),
          reclassedVersionsToUnpublished: Number(reclassedVersionsToUnpublished),
          reclassedModelsToUnpublished: Number(reclassedModelsToUnpublished),
        },
        affected: { modelIds, versionIds, postIds },
      };

      if (dryRun) {
        // Abort the transaction. Caught by the handler and converted into a
        // success response with the counts the real run would produce.
        throw new DryRunRollback(result);
      }

      return result;
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 }
  );
}

async function queueSearchIndexUpdates(affected: AffectedIds) {
  const { modelIds, postIds } = affected;

  if (modelIds.length > 0) {
    await modelsSearchIndex.queueUpdate(
      modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  let imagesReindexed = 0;
  if (postIds.length > 0) {
    // Reindex images on clamped posts — publishedAt feeds the sort/filter
    // keys on Image docs (publishedAtUnix). Chunk so a huge posts table
    // doesn't blow out a single search-index batch.
    for (const batch of chunk(postIds, 500)) {
      const images = await dbWrite.image.findMany({
        where: { postId: { in: batch } },
        select: { id: true },
      });
      if (images.length === 0) continue;
      const updates = images.map((i) => ({
        id: i.id,
        action: SearchIndexUpdateQueueAction.Update,
      }));
      await imagesSearchIndex.queueUpdate(updates);
      await imagesMetricsSearchIndex.queueUpdate(updates);
      imagesReindexed += images.length;
    }
  }

  return { modelsReindexed: modelIds.length, imagesReindexed };
}

async function refreshCaches(affected: AffectedIds) {
  const { modelIds, versionIds } = affected;

  // dataForModelsCache.refresh is per-id; bound concurrency so we don't
  // hammer Redis when there are ~1800 models to invalidate.
  if (modelIds.length > 0) {
    const tasks = modelIds.map((id) => async () => dataForModelsCache.refresh(id));
    await limitConcurrency(tasks, 10);
  }

  if (versionIds.length > 0) {
    const versionRows = await dbWrite.modelVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, modelId: true },
    });
    const tasks = versionRows.map((v) => async () => bustMvCache(v.id, v.modelId));
    await limitConcurrency(tasks, 10);
  }
}

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  }
  const { dryRun } = parsed.data;

  console.log(`[clamp-publishedat-bumps] dryRun=${dryRun} starting`);
  const startTime = Date.now();

  let ops: Ops;
  let affected: AffectedIds;
  try {
    const result = await runClampTransaction(dryRun);
    ops = result.ops;
    affected = result.affected;
  } catch (error) {
    if (error instanceof DryRunRollback) {
      const dbDurationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
      console.log(`[clamp-publishedat-bumps] dry-run complete duration=${dbDurationSec}s`);
      return res.status(200).json({
        dryRun: true,
        dbDurationSec,
        ops: error.payload.ops,
        affectedCounts: {
          models: error.payload.affected.modelIds.length,
          versions: error.payload.affected.versionIds.length,
          posts: error.payload.affected.postIds.length,
        },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clamp-publishedat-bumps] tx failed: ${message}`);
    return res.status(500).json({ error: message });
  }

  const dbDurationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
  console.log(
    `[clamp-publishedat-bumps] tx committed duration=${dbDurationSec}s ` +
      `models=${affected.modelIds.length} versions=${affected.versionIds.length} ` +
      `posts=${affected.postIds.length}`
  );

  const sideEffectsStart = Date.now();
  const { modelsReindexed, imagesReindexed } = await queueSearchIndexUpdates(affected);
  await refreshCaches(affected);
  const sideEffectsDurationSec = Number(((Date.now() - sideEffectsStart) / 1000).toFixed(2));

  return res.status(200).json({
    dryRun: false,
    dbDurationSec,
    sideEffectsDurationSec,
    ops,
    sideEffects: {
      modelsReindexed,
      imagesReindexed,
      modelCachesRefreshed: affected.modelIds.length,
      versionCachesRefreshed: affected.versionIds.length,
      postsClampedQueued: affected.postIds.length,
    },
  });
});
