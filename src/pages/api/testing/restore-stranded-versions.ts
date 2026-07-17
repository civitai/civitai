/**
 * Debug endpoint: restore model versions stranded by the bulk-image-delete bug.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Background (ClickUp 868kdccpq): deleting all of a version's creator showcase
 * images emptied its anchor Post, which the CleanIfEmpty cron deleted, which the
 * reset-to-draft cron then unpublished (meta.unpublishedReason = 'no-posts'),
 * cascading the parent Model to Unpublished (reason 'no-versions'). The deleted
 * posts/images are gone; this restores publish state and recreates an empty
 * anchor Post per version so the creator can re-add images via the wizard.
 *
 * Runs the real publish services (publishModelVersionById / publishModelById) so
 * search-index updates, cache busts, ingestion and validation all fire — raw SQL
 * would skip them. cannotPublish (moderation-blocked) models are excluded.
 *
 * Usage:
 *   GET /api/testing/restore-stranded-versions?token=$WEBHOOK_TOKEN&userId=2253457
 *     &commit=false   dry run (default) — reports the target set, changes nothing
 *     &commit=true    apply the restore
 *     &limit=25       max versions to process this call (default 25). Idempotent:
 *                     a published version drops out of the set, so re-call to drain.
 *
 * Scoped to a single userId per call so a misuse can't cascade across the DB.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { publishModelById } from '~/server/services/model.service';
import type { ModelMeta } from '~/server/schema/model.schema';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const querySchema = z.object({
  userId: z.coerce.number().int().positive(),
  commit: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(25),
});

type Target = { versionId: number; modelId: number; cannotPublish: boolean };

// Strip the keys the reset-to-draft sweep wrote, preserving any other meta.
// Mirrors the controllers' republish branch.
function stripUnpublishMeta(meta: Record<string, unknown> | null | undefined) {
  const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...rest } = meta ?? {};
  return rest;
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { userId, commit, limit } = parsed.data;

  // Versions Unpublished by the no-posts sweep. No owner-post clause here on
  // purpose: a version that got a post but failed to publish stays in the set so
  // a re-run retries it; published versions drop out (idempotent).
  const targets = await dbRead.$queryRaw<Target[]>`
    SELECT mv.id AS "versionId", m.id AS "modelId",
           COALESCE((m.meta->>'cannotPublish')::boolean, false) AS "cannotPublish"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE m."userId" = ${userId}
      AND mv.status = 'Unpublished'
      AND mv.meta->>'unpublishedReason' = 'no-posts'
    ORDER BY mv.id
  `;

  const blocked = targets.filter((t) => t.cannotPublish);
  const eligible = targets.filter((t) => !t.cannotPublish);
  const batch = eligible.slice(0, limit);

  if (!commit) {
    return res.status(200).json({
      dryRun: true,
      userId,
      totalStranded: targets.length,
      eligible: eligible.length,
      blockedCannotPublish: blocked.map((b) => b.modelId),
      wouldProcessThisCall: batch.length,
      sampleVersionIds: batch.slice(0, 20).map((b) => b.versionId),
      note: 'Add &commit=true to apply. Idempotent — re-call to drain the rest.',
    });
  }

  // Group by model so each model + all its stranded versions publish atomically
  // in one publishModelById transaction (avoids a version flipping Published under
  // a still-Unpublished model if a later call fails).
  const byModel = new Map<number, number[]>();
  for (const t of batch) {
    const versionIds = byModel.get(t.modelId) ?? [];
    versionIds.push(t.versionId);
    byModel.set(t.modelId, versionIds);
  }

  const results: Array<{
    modelId: number;
    versionIds: number[];
    postIds?: number[];
    ok: boolean;
    error?: string;
  }> = [];

  for (const [modelId, versionIds] of byModel) {
    try {
      // 1. Recreate an empty owner-owned anchor post per version (if missing) so
      // the version survives the nightly no-posts sweep and the creator has a post
      // to refill via the wizard. The images/posts he deleted are unrecoverable.
      const postIds: number[] = [];
      for (const versionId of versionIds) {
        let post = await dbWrite.post.findFirst({
          where: { modelVersionId: versionId, userId },
          select: { id: true },
        });
        if (!post) {
          post = await dbWrite.post.create({
            data: {
              userId,
              modelVersionId: versionId,
              availability: 'Public',
              publishedAt: new Date(),
              metadata: { restoredFrom: 'no-posts', ticket: '868kdccpq' },
            },
            select: { id: true },
          });
        }
        postIds.push(post.id);
      }

      // 2. Publish model + versions atomically (fixes version availability from the
      // model, restores publishedAt, queues search-index/ingestion, runs validation).
      const model = await dbRead.model.findUnique({
        where: { id: modelId },
        select: { meta: true },
      });
      await publishModelById({
        id: modelId,
        versionIds,
        meta: stripUnpublishMeta(model?.meta as Record<string, unknown> | null) as ModelMeta,
        republishing: true,
      });

      // 3. Clear the sweep's leftover version meta (cosmetic; only after a
      // successful publish so a failed publish stays retryable via the target query).
      await dbWrite.$executeRaw`
        UPDATE "ModelVersion"
        SET meta = meta - 'unpublishedReason' - 'unpublishedAt'
        WHERE id IN (${Prisma.join(versionIds)})
      `;

      results.push({ modelId, versionIds, postIds, ok: true });
    } catch (e) {
      results.push({
        modelId,
        versionIds,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const versionsProcessed = results
    .filter((r) => r.ok)
    .reduce((n, r) => n + r.versionIds.length, 0);
  return res.status(200).json({
    dryRun: false,
    userId,
    modelsProcessed: results.filter((r) => r.ok).length,
    versionsProcessed,
    modelsFailed: results.filter((r) => !r.ok).length,
    remainingEligibleAfterThisCall: Math.max(0, eligible.length - batch.length),
    blockedCannotPublish: blocked.map((b) => b.modelId),
    results,
  });
});
