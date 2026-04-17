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
 *   GET /api/admin/temp/republish-orphaned-drafts?token=WEBHOOK_TOKEN&limit=10
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
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

type Candidate = {
  versionId: number;
  modelId: number;
  userId: number;
  modelName: string;
  postId: number;
  postPublishedAt: Date;
  versionAvailability: string;
};

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const dryRun = req.query.dryRun === 'true';
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

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
      AND p."publishedAt" > NOW() - INTERVAL '30 days'
      AND m."deletedAt"   IS NULL
      AND COALESCE(m.poi, false)   = false
      AND COALESCE(m.minor, false) = false
      AND (m.meta->>'needsReview')   IS NULL
      AND (m.meta->>'cannotPublish') IS NULL
      AND (mv.meta->>'needsReview')  IS NULL
    ORDER BY mv.id, p."publishedAt" ASC
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `);

  console.log(
    `[republish-orphaned-drafts] dryRun=${dryRun} candidates=${candidates.length}`
  );

  const results: Array<{
    versionId: number;
    modelId: number;
    userId: number;
    modelName: string;
    publishedAt: string;
    status: 'ok' | 'error';
    error?: string;
  }> = [];

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      candidateCount: candidates.length,
      candidates: candidates.map((c) => ({
        ...c,
        postPublishedAt: c.postPublishedAt.toISOString(),
      })),
    });
  }

  for (const c of candidates) {
    try {
      const publishedAt = c.postPublishedAt;

      await dbWrite.$transaction(async (tx) => {
        await tx.model.update({
          where: { id: c.modelId },
          data: {
            status: 'Published',
            publishedAt,
            // Clear leftover unpublish metadata if present (set by the
            // auto-unpublish-models-with-no-versions cron while stuck in Draft).
            meta: Prisma.JsonNull,
          },
        });

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
      await dataForModelsCache.bust(c.modelId);
      await modelsSearchIndex.queueUpdate([
        { id: c.modelId, action: SearchIndexUpdateQueueAction.Update },
      ]);

      results.push({
        versionId: c.versionId,
        modelId: c.modelId,
        userId: c.userId,
        modelName: c.modelName,
        publishedAt: publishedAt.toISOString(),
        status: 'ok',
      });

      console.log(
        `[republish-orphaned-drafts] ok modelId=${c.modelId} versionId=${c.versionId}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[republish-orphaned-drafts] error modelId=${c.modelId} versionId=${c.versionId}: ${message}`
      );
      results.push({
        versionId: c.versionId,
        modelId: c.modelId,
        userId: c.userId,
        modelName: c.modelName,
        publishedAt: c.postPublishedAt.toISOString(),
        status: 'error',
        error: message,
      });
    }
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  return res.status(200).json({
    dryRun: false,
    candidateCount: candidates.length,
    okCount,
    errorCount,
    results,
  });
});
