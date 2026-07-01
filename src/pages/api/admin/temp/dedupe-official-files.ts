/**
 * Dedupe CivitaiOfficial component files by linking to a standalone copy.
 * =============================================================================
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Purpose (Subtask A.2 of the "Dedupe Model Resources" epic): the official
 * account uploaded the same accessory file (a VAE / Text Encoder / etc.) both
 * as a standalone model AND bundled as an additional-component file inside a
 * checkpoint. This collapses the bundled copy into a linked-component pointer to
 * the standalone, then deletes the bundled ModelFile so its S3 bytes are
 * reclaimed by the url-refcount GC.
 *
 * Matching rule (validate the candidates with dryRun before applying):
 *   - both files owned by the official account (constants.system.officialUserId)
 *   - identical SHA256
 *   - `redundant`: a component file (VAE / Text Encoder / ControlNet) bundled in
 *     a model whose `Model.type` is NOT the dedicated component type — i.e. the
 *     copy living inside a checkpoint.
 *   - `canonical`: the same blob in a model whose `Model.type` IS the dedicated
 *     component type (VAE→VAE, Text Encoder→TextEncoder, ControlNet→Controlnet)
 *     — the standalone we link to. Lowest version id wins when several exist.
 *   - skipped if the linked-component pointer already exists (idempotent).
 *
 * Verified against prod official data (2026-06-30): this matches bundled
 * components that have a real dedicated standalone, and excludes the noise — a
 * blob shared across sibling checkpoints (no standalone) or Config files shared
 * across ControlNets are NOT touched.
 *
 * Apply reuses the `addLinkedComponent` service (isModerator) which creates the
 * pointer and deletes `replaceFileId` in one call.
 *
 * Usage:
 *   POST /api/admin/temp/dedupe-official-files?token=$WEBHOOK_TOKEN
 *
 * Params (query):
 *   dryRun      - default true. Report candidate pairs without mutating.
 *   limit       - default 500, max 5000. Max candidate pairs to fetch this run.
 *   concurrency - default 1. Parallel addLinkedComponent calls (apply only).
 *                 Default is sequential on purpose: when two redundant files on
 *                 the same source version share a canonical (e.g. Z Image Base's
 *                 two Qwen3 encoders), running them concurrently would race the
 *                 check-then-act dedupe and create duplicate pointer rows.
 *                 Sequential collapses them to one pointer (both files deleted).
 */

import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { inferComponentType } from '~/server/utils/model-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

const log = createLogger('dedupe-official-files', 'cyan');

const OFFICIAL_USER_ID = constants.system.officialUserId;

const querySchema = z.object({
  dryRun: booleanString().default(true),
  limit: z.coerce.number().min(1).max(5000).default(500),
  concurrency: z.coerce.number().min(1).max(10).default(1),
});

type CandidatePair = {
  redundantFileId: number;
  redundantType: string;
  redundantVersionId: number;
  redundantModelId: number;
  canonicalFileId: number;
  canonicalVersionId: number;
  canonicalModelId: number;
  canonicalModelName: string;
  canonicalVersionName: string;
};

async function findCandidatePairs(limit: number) {
  return dbRead.$queryRaw<CandidatePair[]>`
    WITH official_files AS (
      SELECT mf.id, mf.type AS file_type, mf."modelVersionId" AS version_id, mfh.hash,
             mv."modelId" AS model_id, m.name AS model_name, mv.name AS version_name,
             m.type::text AS model_type
      FROM "ModelFile" mf
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE m."userId" = ${OFFICIAL_USER_ID}
    ),
    -- component ModelFile.type -> the dedicated standalone Model.type it lives in
    dedicated (file_type, model_type) AS (
      VALUES ('VAE', 'VAE'), ('Text Encoder', 'TextEncoder'), ('ControlNet', 'Controlnet')
    ),
    canonical AS (
      SELECT DISTINCT ON (o.hash) o.hash,
             o.id AS canonical_file_id, o.version_id AS canonical_version_id,
             o.model_id AS canonical_model_id, o.model_name AS canonical_model_name,
             o.version_name AS canonical_version_name, o.model_type AS canonical_model_type
      FROM official_files o
      WHERE o.model_type IN (SELECT model_type FROM dedicated)
      ORDER BY o.hash, o.version_id ASC
    )
    SELECT r.id                     AS "redundantFileId",
           r.file_type              AS "redundantType",
           r.version_id             AS "redundantVersionId",
           r.model_id               AS "redundantModelId",
           c.canonical_file_id      AS "canonicalFileId",
           c.canonical_version_id   AS "canonicalVersionId",
           c.canonical_model_id     AS "canonicalModelId",
           c.canonical_model_name   AS "canonicalModelName",
           c.canonical_version_name AS "canonicalVersionName"
    FROM official_files r
    JOIN dedicated d ON d.file_type = r.file_type
    JOIN canonical c ON c.hash = r.hash AND c.canonical_model_type = d.model_type
    WHERE r.model_type <> d.model_type
      AND r.id <> c.canonical_file_id
      AND r.version_id <> c.canonical_version_id
      AND NOT EXISTS (
        SELECT 1 FROM "RecommendedResource" rr
        WHERE rr."sourceId" = r.version_id
          AND rr."resourceId" = c.canonical_version_id
          AND rr.settings->>'isLinkedComponent' = 'true'
          AND (rr.settings->>'fileId')::int = c.canonical_file_id
      )
    ORDER BY r.id
    LIMIT ${limit}
  `;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(parsed.error) });
  }
  const { dryRun, limit, concurrency } = parsed.data;
  const startTime = Date.now();

  try {
    log(`Starting${dryRun ? ' (DRY RUN)' : ''} | limit=${limit} concurrency=${concurrency}`);
    const candidates = await findCandidatePairs(limit);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        candidateCount: candidates.length,
        candidates,
        durationMs: Date.now() - startTime,
      });
    }

    const stats = { linked: 0, skippedNoComponentType: 0, failed: 0 };
    const failures: { redundantFileId: number; error: string }[] = [];

    const tasks = candidates.map((pair) => async () => {
      const componentType = inferComponentType(pair.redundantType);
      if (!componentType) {
        stats.skippedNoComponentType++;
        return;
      }
      try {
        await addLinkedComponent({
          id: pair.redundantVersionId,
          targetVersionId: pair.canonicalVersionId,
          targetFileId: pair.canonicalFileId,
          replaceFileId: pair.redundantFileId,
          componentType,
          modelId: pair.canonicalModelId,
          modelName: pair.canonicalModelName,
          versionName: pair.canonicalVersionName,
          isRequired: true,
          userId: OFFICIAL_USER_ID,
          isModerator: true,
        });
        stats.linked++;
      } catch (e) {
        stats.failed++;
        failures.push({ redundantFileId: pair.redundantFileId, error: (e as Error).message });
      }
    });

    await limitConcurrency(tasks, concurrency);

    log(`Done | linked=${stats.linked} failed=${stats.failed}`);
    return res.status(200).json({
      ok: true,
      dryRun: false,
      candidateCount: candidates.length,
      ...stats,
      failures,
      durationMs: Date.now() - startTime,
    });
  } catch (e) {
    log('Error', e);
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
