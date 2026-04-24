/**
 * One-time endpoint to fix models silently orphaned in Draft by the
 * PostUpsertForm2 afterPublish bug (fixed in commit ffc3d7a13).
 *
 * Finds model versions where:
 *   - Model.status = 'Draft' and ModelVersion.status = 'Draft'
 *   - A Post owned by the same user is already published
 *   - A Model-type file is attached
 *   - No moderator-relevant flags (poi/minor/needsReview/cannotPublish)
 *   - Post was published within the last 30 days
 *
 * For each: flips Model and ModelVersion to Published using the Post's
 * existing publishedAt, normalizes ModelVersion availability to Public, and
 * triggers the NSFW-level + search-index cascade.
 *
 * Intentionally bypasses publishModelById because we want to avoid:
 *   - re-running ingestion (files/images already scanned)
 *   - firing a fresh "Publish" notification for an event that happened weeks ago
 *
 * Run with:
 *   GET /api/admin/temp/republish-orphaned-drafts?token=WEBHOOK_TOKEN&dryRun=true
 *   GET /api/admin/temp/republish-orphaned-drafts?token=WEBHOOK_TOKEN
 *   GET /api/admin/temp/republish-orphaned-drafts?token=WEBHOOK_TOKEN&batchSize=10&concurrency=3
 *   GET /api/admin/temp/republish-orphaned-drafts?token=WEBHOOK_TOKEN&modelIds=2548032,160433
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dataForModelsCache } from '~/server/redis/caches';
import { bustMvCache } from '~/server/services/model-version.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  dryRun: booleanString().default(false),
  concurrency: z.coerce.number().min(1).max(20).default(5),
  batchSize: z.coerce.number().min(1).max(500).default(25),
  limit: z.coerce.number().min(1).optional(),
  // Comma-separated list of Model IDs to target. When set, bypasses the
  // 30-day recency filter so you can fix specific user reports, but still
  // enforces the Draft/has-file/safety-flag guards.
  modelIds: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !isNaN(id))
        : undefined
    ),
});

type Candidate = {
  versionId: number;
  modelId: number;
  userId: number;
  modelName: string;
  postId: number;
  postPublishedAt: Date;
  versionAvailability: string;
};

type Result = {
  versionId: number;
  modelId: number;
  userId: number;
  modelName: string;
  publishedAt: string;
  status: 'ok' | 'error';
  error?: string;
};

async function republishOne(c: Candidate): Promise<Result> {
  const publishedAt = c.postPublishedAt;

  try {
    await dbWrite.$transaction(async (tx) => {
      // Use raw SQL here so we can surgically strip only the unpublish keys
      // from Model.meta (Prisma's typed update can't do JSON key subtraction).
      // Strip keys set by the auto-unpublish-models-with-no-versions cron
      // while stuck in Draft; preserve anything else a mod/user may have set.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "Model"
        SET "status"      = 'Published',
            "publishedAt" = ${publishedAt},
            "meta"        = COALESCE("meta", '{}'::jsonb)
                              - 'unpublishedAt'
                              - 'unpublishedReason'
                              - 'unpublishedBy'
        WHERE id = ${c.modelId}
      `);

      await tx.modelVersion.update({
        where: { id: c.versionId },
        data: {
          status: 'Published',
          publishedAt,
          availability: 'Public',
        },
      });

      // Defensive: sync any other Posts on this version to the same
      // publishedAt if they were orphaned similarly. Matches the logic in
      // publishModelById but with the specific versionId scope.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "Post" p
        SET "publishedAt" = ${publishedAt},
            "metadata"    = COALESCE(p."metadata", '{}'::jsonb) - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
        WHERE p."modelVersionId" = ${c.versionId}
          AND p."userId"         = ${c.userId}
          AND (p."publishedAt" IS NULL OR p."publishedAt" <> ${publishedAt})
      `);
    });

    // Recompute NSFW levels (version first, then model, since Model
    // aggregates from Published versions only).
    await updateModelVersionNsfwLevels([c.versionId]);
    await updateModelNsfwLevels([c.modelId]);

    // Cache + search index
    await bustMvCache(c.versionId, c.modelId);
    await dataForModelsCache.refresh(c.modelId);
    await modelsSearchIndex.queueUpdate([
      { id: c.modelId, action: SearchIndexUpdateQueueAction.Update },
    ]);

    return {
      versionId: c.versionId,
      modelId: c.modelId,
      userId: c.userId,
      modelName: c.modelName,
      publishedAt: publishedAt.toISOString(),
      status: 'ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      versionId: c.versionId,
      modelId: c.modelId,
      userId: c.userId,
      modelName: c.modelName,
      publishedAt: publishedAt.toISOString(),
      status: 'error',
      error: message,
    };
  }
}

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  }
  const { dryRun, concurrency, batchSize, limit, modelIds } = parsed.data;

  // When modelIds is provided we bypass the 30-day window (explicit targeting
  // for user reports) but still enforce the Draft/has-file/safety-flag guards.
  const modelIdFilter =
    modelIds && modelIds.length > 0
      ? Prisma.sql`AND m.id IN (${Prisma.join(modelIds)})`
      : Prisma.sql`AND p."publishedAt" > NOW() - INTERVAL '30 days'`;

  const candidates = await dbRead.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT DISTINCT ON (mv.id)
      mv.id              AS "versionId",
      m.id               AS "modelId",
      m."userId"         AS "userId",
      m.name             AS "modelName",
      p.id               AS "postId",
      p."publishedAt"    AS "postPublishedAt",
      mv.availability    AS "versionAvailability"
    FROM "ModelVersion" mv
    JOIN "Model"     m ON m.id = mv."modelId"
    JOIN "Post"      p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
    JOIN "ModelFile" f ON f."modelVersionId" = mv.id AND f.type = 'Model'
    WHERE mv.status       = 'Draft'
      AND m.status        = 'Draft'
      AND p."publishedAt" IS NOT NULL
      ${modelIdFilter}
      AND m."deletedAt"   IS NULL
      AND COALESCE(m.poi, false)   = false
      AND COALESCE(m.minor, false) = false
      AND (m.meta->>'needsReview')   IS NULL
      AND (m.meta->>'cannotPublish') IS NULL
      AND (mv.meta->>'needsReview')  IS NULL
    ORDER BY mv.id, p."publishedAt" ASC
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `);

  const targetingSuffix =
    modelIds && modelIds.length > 0 ? ` modelIds=[${modelIds.join(',')}]` : '';
  console.log(
    `[republish-orphaned-drafts] dryRun=${dryRun} candidates=${candidates.length} batchSize=${batchSize} concurrency=${concurrency}${targetingSuffix}`
  );

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      candidateCount: candidates.length,
      batchSize,
      concurrency,
      candidates: candidates.map((c) => ({
        ...c,
        postPublishedAt: c.postPublishedAt.toISOString(),
      })),
    });
  }

  const startTime = Date.now();
  const results: Result[] = [];
  const batches = chunk(candidates, batchSize);

  for (const [batchIndex, batch] of batches.entries()) {
    console.log(
      `[republish-orphaned-drafts] batch ${batchIndex + 1}/${batches.length} (${
        batch.length
      } items)`
    );

    const tasks = batch.map((c) => async () => {
      const result = await republishOne(c);
      results.push(result);
      const suffix = result.error ? ` error=${result.error}` : '';
      console.log(
        `[republish-orphaned-drafts] ${result.status} modelId=${c.modelId} versionId=${c.versionId}${suffix}`
      );
    });

    await limitConcurrency(tasks, concurrency);
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.filter((r) => r.status === 'error').length;
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(
    `[republish-orphaned-drafts] done ok=${okCount} error=${errorCount} duration=${durationSec}s`
  );

  return res.status(200).json({
    dryRun: false,
    candidateCount: candidates.length,
    batches: batches.length,
    batchSize,
    concurrency,
    durationSec: Number(durationSec),
    okCount,
    errorCount,
    results,
  });
});
