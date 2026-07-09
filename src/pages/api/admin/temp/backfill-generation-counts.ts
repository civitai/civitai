import type { NextApiRequest, NextApiResponse } from 'next';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { PG_INT4_MAX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { pgDbWrite } from '~/server/db/pgDb';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * One-off reconcile for stale `ModelVersionMetric.generationCount` (and the
 * `ModelMetric.generationCount` rollup shown on the model card).
 *
 * Regression c186546ad9 (2026-05-14) narrowed the metrics-job flag window to a
 * 1-minute `orchestration.jobs` slice, so a version that goes quiet freezes at
 * whatever partial all-time SUM was last written — an undercount (or 0 if the
 * MV had not materialized yet). The going-forward fix only heals versions
 * active today; already-frozen versions need this backfill.
 *
 * Source of truth: orchestration.daily_resource_generation_counts (ClickHouse).
 * Scoped to versions with generation activity since `sinceDate` (pre-regression
 * versions settled correctly under the old code).
 *
 * GET/POST /api/admin/temp/backfill-generation-counts?token=$WEBHOOK_TOKEN
 *   sinceDate  ISO date, default 2026-05-14 (regression deploy). Only versions
 *              active on/after this date are reconciled.
 *   batchSize  versions per PG write batch (1-10000, default 2000)
 *   dryRun     true = report mismatches + top gaps, write nothing (default false)
 *   reindex    true = re-queue corrected models for search-index sync (default true)
 */

const schema = z.object({
  sinceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .default('2026-05-14'),
  batchSize: z.coerce.number().min(1).max(10000).optional().default(2000),
  // z.coerce.boolean() treats "false" as true — compare the raw string instead.
  dryRun: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  reindex: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
});

type TruthRow = { modelVersionId: number; generationCount: number };
type GapRow = { modelId: number; modelVersionId: number; stored: number; truth: number };

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { sinceDate, batchSize, dryRun, reindex } = schema.parse(req.query);
  if (!clickhouse) {
    res.status(500).json({ error: 'ClickHouse client not available' });
    return;
  }

  // 1. All-time generation SUM for every version active since sinceDate.
  const truth = await clickhouse.$query<TruthRow>(`
    SELECT modelVersionId, toInt64(SUM(count)) AS generationCount
    FROM orchestration.daily_resource_generation_counts
    WHERE modelVersionId GLOBAL IN (
      SELECT DISTINCT modelVersionId
      FROM orchestration.daily_resource_generation_counts
      WHERE createdDate >= toDate('${sinceDate}') AND modelVersionId > 0
    )
      AND createdDate <= today()
      AND count <= ${PG_INT4_MAX}
    GROUP BY modelVersionId
    HAVING generationCount BETWEEN 0 AND ${PG_INT4_MAX}
  `);

  const affectedModelIds = new Set<number>();
  let versionsChanged = 0;
  let modelsUpdated = 0;
  let topGaps: Array<GapRow & { gap: number }> = [];

  const trackGaps = (rows: GapRow[]) => {
    for (const r of rows) topGaps.push({ ...r, gap: r.truth - Math.max(r.stored, 0) });
    if (topGaps.length > 500) {
      topGaps.sort((a, b) => b.gap - a.gap);
      topGaps = topGaps.slice(0, 100);
    }
  };

  // 2. Per batch: find/fix mismatched ModelVersionMetric rows.
  for (const batch of chunk(truth, batchSize)) {
    const payload = JSON.stringify(
      batch.map((r) => ({ modelVersionId: r.modelVersionId, generationCount: Number(r.generationCount) }))
    );

    if (dryRun) {
      const q = await pgDbWrite.cancellableQuery<GapRow>(
        `
        WITH data AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("modelVersionId" INT, "generationCount" INT)
        )
        SELECT mv."modelId",
               d."modelVersionId",
               COALESCE(mvm."generationCount", -1) AS stored,
               d."generationCount" AS truth
        FROM data d
        JOIN "ModelVersion" mv ON mv.id = d."modelVersionId"
        LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = d."modelVersionId"
        WHERE COALESCE(mvm."generationCount", -1) <> d."generationCount"
        `,
        [payload]
      );
      const rows = await q.result();
      versionsChanged += rows.length;
      rows.forEach((r) => affectedModelIds.add(r.modelId));
      trackGaps(rows);
      continue;
    }

    // Mirror the metrics-job upsert: FK-guard on ModelVersion, conflict on the
    // modelVersionId pkey, timeframe defaults to 'AllTime'. Only touch rows that
    // actually change so updatedAt churn (and search-index re-queue) stays minimal.
    const q = await pgDbWrite.cancellableQuery<{ modelVersionId: number }>(
      `
      WITH data AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("modelVersionId" INT, "generationCount" INT)
      )
      INSERT INTO "ModelVersionMetric" ("modelVersionId", "updatedAt", "generationCount")
      SELECT d."modelVersionId", NOW(), d."generationCount"
      FROM data d
      LEFT JOIN "ModelVersionMetric" im ON im."modelVersionId" = d."modelVersionId"
      WHERE EXISTS (SELECT 1 FROM "ModelVersion" WHERE id = d."modelVersionId")
        AND COALESCE(im."generationCount", -1) <> d."generationCount"
      ON CONFLICT ("modelVersionId") DO UPDATE
        SET "generationCount" = EXCLUDED."generationCount", "updatedAt" = NOW()
      RETURNING "modelVersionId"
      `,
      [payload]
    );
    const updated = await q.result();
    versionsChanged += updated.length;

    if (updated.length) {
      const midQ = await pgDbWrite.cancellableQuery<{ modelId: number }>(
        `SELECT DISTINCT "modelId" FROM "ModelVersion" WHERE id = ANY($1::int[])`,
        [updated.map((u) => u.modelVersionId)]
      );
      (await midQ.result()).forEach((m) => affectedModelIds.add(m.modelId));
    }
  }

  const modelIds = [...affectedModelIds];
  const updatedModelIds: number[] = [];

  // 3. Roll the corrected version metrics up to ModelMetric.generationCount.
  if (!dryRun && modelIds.length) {
    for (const idBatch of chunk(modelIds, 1000)) {
      const q = await pgDbWrite.cancellableQuery<{ modelId: number }>(
        `
        UPDATE "ModelMetric" mm
        SET "generationCount" = agg.total, "updatedAt" = NOW()
        FROM (
          -- LEAST guards the INT4 target: a model summing past 2^31-1 across its
          -- versions would otherwise error the whole batch.
          SELECT mv."modelId", LEAST(SUM(mvm."generationCount"), ${PG_INT4_MAX})::int AS total
          FROM "ModelVersionMetric" mvm
          JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
          WHERE mv."modelId" = ANY($1::int[])
          GROUP BY mv."modelId"
        ) agg
        WHERE mm."modelId" = agg."modelId"
          AND mm."generationCount" <> agg.total
        RETURNING mm."modelId"
        `,
        [idBatch]
      );
      updatedModelIds.push(...(await q.result()).map((r) => r.modelId));
    }
    modelsUpdated = updatedModelIds.length;

    // 4. Re-queue only the models whose rollup actually changed.
    if (reindex) {
      for (const slice of chunk(updatedModelIds, 5000)) {
        await modelsSearchIndex.queueUpdate(
          slice.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
        );
      }
    }
  }

  topGaps.sort((a, b) => b.gap - a.gap);

  res.status(200).json({
    dryRun,
    sinceDate,
    versionsScanned: truth.length,
    versionsChanged,
    modelsAffected: modelIds.length,
    modelsUpdated: dryRun ? undefined : modelsUpdated,
    reindexed: !dryRun && reindex ? updatedModelIds.length : 0,
    topGaps: topGaps.slice(0, 25),
  });
});
