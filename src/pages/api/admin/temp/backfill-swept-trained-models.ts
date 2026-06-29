/**
 * One-time backfill for the "disappearing trained models" sweep.
 * =============================================================================
 *
 * Hidden admin route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Background:
 *   A published trained model's auto-created showcase post can be emptied
 *   (sample images moderation-blocked) -> clean-if-empty deletes the post ->
 *   the nightly reset-to-draft-without-requirements cron unpublishes the
 *   ownerless version (status=Unpublished, availability=Private,
 *   meta.unpublishedReason='no-posts') and, when no published version remains,
 *   unpublishes the parent Model too (meta.unpublishedReason='no-versions').
 *   The model then vanishes from the user's Training tab.
 *
 *   The cron now routes trained versions/models to Draft (not Unpublished), so
 *   this can't recur — this endpoint is a one-time cleanup of the rows the old
 *   cron already swept to Unpublished. It backfills them back to Draft so they
 *   reappear in the trainer and are recoverable through the normal publish flow,
 *   scoped to trained versions that still have no owner post.
 *
 *   Distinct from republish-orphaned-drafts.ts (the inverse case: Draft rows
 *   that already have a published owner post -> re-Published). Here the rows are
 *   Unpublished and postless, so the only safe recovery target is Draft.
 *
 * Usage:
 *   POST /api/admin/temp/backfill-swept-trained-models?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for authoritative param list):
 *   count   - {modelId?}          Preview how many trained versions / models match (no write).
 *   apply   - {limit?, modelId?}  Reset matching versions (and their orphaned parent
 *                                 models) to Draft.
 *                                 - limit caps the number of versions per run (staged rollouts).
 *                                 - modelId scopes to one model for spot-fixes.
 *
 * Target predicate (a swept, still-postless trained version):
 *   mv.status = 'Unpublished' AND mv.uploadType = 'Trained'
 *   AND NOT EXISTS (owner-authored Post for the version)
 *
 * 'Unpublished' (not 'UnpublishedViolation') is required, so genuine ToS
 * removals are never resurfaced. availability is intentionally NOT filtered: the
 * sweep itself stamps availability='Private', so the rows we want are Private.
 * meta.unpublishedReason / unpublishedAt are left untouched — they're old, so
 * they don't re-trigger the unpublish notification (which keys off unpublishedAt
 * > lastSent), and they flip back on the next user-initiated publish.
 *
 * apply re-asserts the full predicate (not just the selected id list), so a row
 * that changed between selection and write is skipped, never clobbered; re-running
 * is safe. Both actions are gated by WEBHOOK_TOKEN; count never writes.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const actionSchema = z.enum(['count', 'apply']);

const schema = z.object({
  action: actionSchema,
  modelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50_000).optional(),
});

// A swept trained version: was published, lost its owner post, got unpublished
// by reset-to-draft-without-requirements, and still has no owner post.
const TARGET_PREDICATE = `mv.status = 'Unpublished'
    AND mv."uploadType" = 'Trained'
    AND NOT EXISTS (
      SELECT 1 FROM "Post" p
      WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId"
    )`;

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const input = payload.data;
  const modelFilter = input.modelId ? `AND m.id = ${input.modelId}` : '';
  const limitClause = input.limit ? `LIMIT ${input.limit}` : '';

  switch (input.action) {
    case 'count': {
      const rows = await dbRead.$queryRawUnsafe<{ modelCount: bigint; versionCount: bigint }[]>(`
        SELECT
          COUNT(DISTINCT m.id)::bigint AS "modelCount",
          COUNT(*)::bigint AS "versionCount"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ${TARGET_PREDICATE} ${modelFilter}
      `);
      const { modelCount, versionCount } = rows[0] ?? {
        modelCount: BigInt(0),
        versionCount: BigInt(0),
      };
      return res.status(200).json({
        action: 'count',
        modelId: input.modelId ?? null,
        modelCount: Number(modelCount),
        versionCount: Number(versionCount),
      });
    }

    case 'apply': {
      const result = await dbWrite.$transaction(async (tx) => {
        // Select candidates on the primary inside the tx (current data, no
        // replica lag). limit applies here for staged rollouts.
        const targets = await tx.$queryRawUnsafe<{ id: number }[]>(`
          SELECT mv.id
          FROM "ModelVersion" mv
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE ${TARGET_PREDICATE} ${modelFilter}
          ${limitClause}
        `);
        const ids = targets.map((t) => t.id);
        if (!ids.length) return { versions: 0, models: 0, sample: [] as number[] };

        // Re-assert the full predicate in the write so a row that changed since
        // selection is skipped rather than clobbered (idempotent on re-run).
        const draftedVersions = await tx.$queryRaw<{ id: number; modelId: number }[]>`
          UPDATE "ModelVersion" mv
          SET status = 'Draft'
          FROM "Model" m
          WHERE mv."modelId" = m.id
            AND mv.id IN (${Prisma.join(ids)})
            AND mv.status = 'Unpublished'
            AND mv."uploadType" = 'Trained'
            AND NOT EXISTS (
              SELECT 1 FROM "Post" p WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId"
            )
          RETURNING mv.id, mv."modelId"
        `;

        const modelIds = [...new Set(draftedVersions.map((v) => v.modelId))];
        let draftedModels = 0;
        if (modelIds.length) {
          // Only models the no-versions sweep left Unpublished with no published
          // version — a model still holding a live published version is untouched.
          const models = await tx.$queryRaw<{ id: number }[]>`
            UPDATE "Model" m
            SET status = 'Draft'
            WHERE m.id IN (${Prisma.join(modelIds)})
              AND m.status = 'Unpublished'
              AND NOT EXISTS (
                SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published'
              )
            RETURNING m.id
          `;
          draftedModels = models.length;
        }

        return {
          versions: draftedVersions.length,
          models: draftedModels,
          sample: draftedVersions.slice(0, 10).map((v) => v.id),
        };
      });

      return res.status(200).json({
        action: 'apply',
        modelId: input.modelId ?? null,
        limit: input.limit ?? null,
        draftedVersions: result.versions,
        draftedModels: result.models,
        sampleVersionIds: result.sample,
      });
    }
  }
});
