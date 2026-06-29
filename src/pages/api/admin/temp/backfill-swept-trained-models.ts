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
 *   apply   - {limit?, modelId?, batchSize?, concurrency?}
 *                                 Reset matching versions (and their orphaned parent
 *                                 models) to Draft, in chunked autocommit batches.
 *                                 - limit caps the number of versions per run (staged rollouts).
 *                                 - modelId scopes to one model for spot-fixes.
 *                                 - batchSize rows per UPDATE (default 250, max 1000).
 *                                 - concurrency parallel batches (default 4, max 10).
 *
 * Target predicate (a swept, still-postless trained version):
 *   mv.status = 'Unpublished' AND mv.uploadType = 'Trained'
 *   AND mv.meta->>'unpublishedReason' = 'no-posts'
 *   AND NOT EXISTS (owner-authored Post for the version)
 *
 * The unpublishedReason='no-posts' filter is load-bearing for safety: status
 * 'Unpublished' alone is NOT enough to distinguish the automated requirements
 * sweep from moderator removals — mods unpublish ToS/CSAM content with
 * status='Unpublished' + a moderation reason (mature-real-person, *-underage,
 * beastiality, etc.), not only 'UnpublishedViolation'. Scoping to the cron's
 * own 'no-posts' reason is what keeps those out (~11k of ~14k matched by the
 * looser predicate were NOT no-posts). The parent-model update is likewise
 * scoped to the cron's 'no-versions' reason. availability is intentionally NOT
 * filtered: the sweep itself stamps availability='Private', so the rows we want
 * are Private. meta.unpublishedReason / unpublishedAt are left untouched — old
 * unpublishedAt won't re-trigger the unpublish notification (keys off
 * unpublishedAt > lastSent), and both flip back on the next publish.
 *
 * apply runs chunked autocommit UPDATEs (NOT one interactive $transaction —
 * Prisma caps those at 5s and the full cohort exceeds it). Each batch re-asserts
 * the full predicate, so a row that changed since selection is skipped, never
 * clobbered, and the backfill is idempotent — a partial run is finished by
 * re-running. Both actions are gated by WEBHOOK_TOKEN; count never writes.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const actionSchema = z.enum(['count', 'apply']);

const schema = z.object({
  action: actionSchema,
  modelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50_000).optional(),
  batchSize: z.coerce.number().int().positive().max(1_000).default(250),
  concurrency: z.coerce.number().int().min(1).max(10).default(4),
});

// A swept trained version: was published, lost its owner post, got unpublished
// by reset-to-draft-without-requirements (reason 'no-posts'), and still has no
// owner post. The reason filter excludes moderator removals that also use
// status='Unpublished' (see header).
const TARGET_PREDICATE = `mv.status = 'Unpublished'
    AND mv."uploadType" = 'Trained'
    AND mv.meta->>'unpublishedReason' = 'no-posts'
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
      // No interactive $transaction: Prisma caps those at 5s and the full
      // cohort (~2.7k rows + correlated NOT EXISTS) blows past it. Instead select
      // the candidate ids once, then drive chunked autocommit UPDATEs (each its
      // own statement, bound only by statement_timeout). Cross-batch atomicity
      // isn't needed — every batch re-asserts the predicate, so the backfill is
      // idempotent and a partial run is finished by re-running.
      const { batchSize, concurrency } = input;

      // Candidate selection on the primary (no replica lag). limit caps the run.
      const targets = await dbWrite.$queryRawUnsafe<{ id: number }[]>(`
        SELECT mv.id
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ${TARGET_PREDICATE} ${modelFilter}
        ${limitClause}
      `);
      const ids = targets.map((t) => t.id);
      if (!ids.length) {
        return res.status(200).json({
          action: 'apply',
          modelId: input.modelId ?? null,
          limit: input.limit ?? null,
          draftedVersions: 0,
          draftedModels: 0,
          sampleVersionIds: [],
        });
      }

      // Draft the versions in chunks. Each batch re-asserts the full predicate so
      // a row that changed since selection is skipped, never clobbered.
      const draftedModelIds = new Set<number>();
      const sample: number[] = [];
      let draftedVersions = 0;
      const versionTasks = chunk(ids, batchSize).map((batch) => async () => {
        const rows = await dbWrite.$queryRaw<{ id: number; modelId: number }[]>`
          UPDATE "ModelVersion" mv
          SET status = 'Draft'
          FROM "Model" m
          WHERE mv."modelId" = m.id
            AND mv.id IN (${Prisma.join(batch)})
            AND mv.status = 'Unpublished'
            AND mv."uploadType" = 'Trained'
            AND mv.meta->>'unpublishedReason' = 'no-posts'
            AND NOT EXISTS (
              SELECT 1 FROM "Post" p WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId"
            )
          RETURNING mv.id, mv."modelId"
        `;
        draftedVersions += rows.length;
        for (const r of rows) {
          draftedModelIds.add(r.modelId);
          if (sample.length < 10) sample.push(r.id);
        }
      });
      await limitConcurrency(versionTasks, concurrency);

      // Draft the parent models the no-versions sweep left Unpublished with no
      // published version. Scoped to the cron's 'no-versions' reason so a
      // moderator-unpublished parent (different reason) is never resurfaced.
      let draftedModels = 0;
      const modelTasks = chunk([...draftedModelIds], batchSize).map((batch) => async () => {
        const rows = await dbWrite.$queryRaw<{ id: number }[]>`
          UPDATE "Model" m
          SET status = 'Draft'
          WHERE m.id IN (${Prisma.join(batch)})
            AND m.status = 'Unpublished'
            AND m.meta->>'unpublishedReason' = 'no-versions'
            AND NOT EXISTS (
              SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published'
            )
          RETURNING m.id
        `;
        draftedModels += rows.length;
      });
      await limitConcurrency(modelTasks, concurrency);

      return res.status(200).json({
        action: 'apply',
        modelId: input.modelId ?? null,
        limit: input.limit ?? null,
        batchSize,
        concurrency,
        draftedVersions,
        draftedModels,
        sampleVersionIds: sample,
      });
    }
  }
});
