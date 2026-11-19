/**
 * Debug endpoint for the Model.nsfw flip / ModelVersion.nsfwLevel stale rollup bug.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Background:
 *   When Model.nsfw was true, updateModelVersionNsfwLevels stamped every
 *   ModelVersion.nsfwLevel to nsfwBrowsingLevelsFlag (60 = R|X|XXX|Blocked).
 *   The Model trigger only enqueued a Model-level UpdateNsfwLevel job on
 *   nsfw flip — versions never got recomputed. After Model.nsfw flipped
 *   true->false, updateModelNsfwLevels did bit_or over (still-stale)
 *   versions = 60, wrote 60 back to Model, and the model stayed
 *   .com-hidden forever. The trigger fix in migration
 *   20260519120000_fix_model_nsfw_flip_version_cascade prevents new
 *   occurrences. This endpoint backfills the existing stuck rows by
 *   enqueueing ModelVersion UpdateNsfwLevel jobs; the update-nsfw-levels
 *   cron (`*\/1 * * * *`) processes them within ~5-10 minutes.
 *
 * Usage:
 *   POST /api/testing/backfill-stale-nsfw-rollups?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for authoritative param list):
 *   count           - {modelId?}                  Preview how many models/versions are stuck (m.nsfw=false AND m.nsfwLevel & 32 != 0).
 *   enqueue         - {limit?, modelId?, dryRun?} Insert ModelVersion UpdateNsfwLevel rows into JobQueue.
 *                                                  - limit caps the number of versions enqueued (use for staged rollouts).
 *                                                  - modelId scopes to one model for spot-fixes.
 *                                                  - dryRun=true counts without writing.
 *   verify          - {modelId?}                  Re-run the stored-vs-recomputed comparison; expect 0 mismatches after drain.
 *
 * `predicate=mature-safe-bit` switches count and enqueue to the opposite drift: a mature model
 * (nsfw = true) whose Published versions, or whose own level without a civitai.com face, still carry
 * a safe bit. The nightly check-mature-safe-bit-drift job runs the same predicate, and enqueue has
 * its cap: over 500 rows it queues nothing (scope it with modelId).
 *
 * Every write is gated by WEBHOOK_TOKEN. The enqueue action only writes into
 * JobQueue (an ON CONFLICT DO NOTHING insert) — same path the trigger uses —
 * so worst case is re-running an already-queued recompute.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  countMatureSafeBitDrift,
  enqueueMatureSafeBitDrift,
} from '~/server/services/nsfw-rollup-drift.service';
import { imageDerivedVersionLevelSql } from '~/server/services/nsfwLevels.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const actionSchema = z.enum(['count', 'enqueue', 'verify']);

const schema = z
  .object({
    action: actionSchema,
    predicate: z.enum(['stale-mature-bit', 'mature-safe-bit']).default('stale-mature-bit'),
    modelId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(50_000).optional(),
    // booleanString, not z.coerce.boolean: this schema is parsed against req.query, where
    // coerce runs JS Boolean() and makes `?dryRun=false` TRUE — enqueue then writes nothing
    // and reports a preview, so the backfill looks done without a single row queued.
    dryRun: booleanString().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'verify' && data.limit !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'verify does not accept limit', path: ['limit'] });
    }
    if (data.predicate === 'mature-safe-bit' && data.action === 'verify') {
      ctx.addIssue({ code: 'custom', message: 'use count for mature-safe-bit', path: ['action'] });
    }
    if (data.predicate === 'mature-safe-bit' && data.limit !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'mature-safe-bit has no limit', path: ['limit'] });
    }
  });

const STUCK_PREDICATE = `m.status = 'Published'
    AND mv.status = 'Published'
    AND NOT m.nsfw
    AND m."nsfwLevel" & 32 != 0`;

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const input = payload.data;

  if (input.predicate === 'mature-safe-bit') {
    if (input.action === 'count' || input.dryRun) {
      const counts = await countMatureSafeBitDrift(input.modelId);
      return res.status(200).json({
        action: input.action,
        predicate: input.predicate,
        dryRun: !!input.dryRun,
        ...counts,
      });
    }
    // Capped like the nightly job: over the cap it queues nothing and says so.
    const result = await enqueueMatureSafeBitDrift(input.modelId);
    return res
      .status(200)
      .json({ action: 'enqueue', predicate: input.predicate, dryRun: false, ...result });
  }

  switch (input.action) {
    case 'count': {
      const modelFilter = input.modelId ? `AND m.id = ${input.modelId}` : '';
      const rows = await dbRead.$queryRawUnsafe<{ modelCount: bigint; versionCount: bigint }[]>(`
        SELECT
          COUNT(DISTINCT m.id)::bigint AS "modelCount",
          COUNT(*)::bigint AS "versionCount"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ${STUCK_PREDICATE} ${modelFilter}
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

    case 'enqueue': {
      const modelFilter = input.modelId ? `AND m.id = ${input.modelId}` : '';
      const limitClause = input.limit ? `LIMIT ${input.limit}` : '';

      if (input.dryRun) {
        const rows = await dbRead.$queryRawUnsafe<{ count: bigint }[]>(`
          SELECT COUNT(*)::bigint AS count FROM (
            SELECT mv.id
            FROM "ModelVersion" mv
            JOIN "Model" m ON m.id = mv."modelId"
            WHERE ${STUCK_PREDICATE} ${modelFilter}
            ${limitClause}
          ) s
        `);
        return res.status(200).json({
          action: 'enqueue',
          dryRun: true,
          modelId: input.modelId ?? null,
          limit: input.limit ?? null,
          wouldEnqueue: Number(rows[0]?.count ?? BigInt(0)),
        });
      }

      const inserted = await dbWrite.$queryRawUnsafe<{ id: number }[]>(`
        INSERT INTO "JobQueue" ("entityId", "entityType", "type")
        SELECT mv.id, 'ModelVersion'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ${STUCK_PREDICATE} ${modelFilter}
        ${limitClause}
        ON CONFLICT DO NOTHING
        RETURNING "entityId" AS id
      `);
      return res.status(200).json({
        action: 'enqueue',
        dryRun: false,
        modelId: input.modelId ?? null,
        limit: input.limit ?? null,
        enqueued: inserted.length,
        sampleVersionIds: inserted.slice(0, 10).map((r) => r.id),
      });
    }

    case 'verify': {
      const modelFilter = input.modelId ? Prisma.sql`AND m.id = ${input.modelId}` : Prisma.empty;
      // LATERAL so the bit_or subquery runs once per row instead of twice
      // (correlated subqueries in both SELECT and WHERE are not deduped by
      // the planner) — keeps verify scans bounded when the cohort is
      // large and the cache is cold.
      // Non-mature models only: a mature model's versions are stamped, not derived.
      const rows = await dbRead.$queryRaw<
        {
          modelVersionId: number;
          modelId: number;
          storedNsfwLevel: number;
          recomputedNsfwLevel: number;
        }[]
      >(Prisma.sql`
        SELECT
          mv.id AS "modelVersionId",
          m.id AS "modelId",
          mv."nsfwLevel" AS "storedNsfwLevel",
          r."recomputed" AS "recomputedNsfwLevel"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        JOIN LATERAL (SELECT ${imageDerivedVersionLevelSql} AS "recomputed") r ON TRUE
        WHERE mv.status = 'Published'
          AND m.status = 'Published'
          AND NOT m.nsfw
          AND m."userId" != -1
          ${modelFilter}
          AND mv."nsfwLevel" != r."recomputed"
        LIMIT 100
      `);
      return res.status(200).json({
        action: 'verify',
        modelId: input.modelId ?? null,
        mismatchCount: rows.length,
        sample: rows.slice(0, 20),
      });
    }
  }
});
