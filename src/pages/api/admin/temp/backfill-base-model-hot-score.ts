import type { NextApiRequest, NextApiResponse } from 'next';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * One-off population of the per-base-model hot score columns added by migration
 * 20261012120000: `generationCount`, `uniqueGeneratorCount` and `publishedAt` on
 * `ModelBaseModelMetric`.
 *
 * Until a row has all three, its trigger mirrors the whole-model score — which is what
 * filtered feeds ranked on before, and why a model with versions in several ecosystems
 * could outrank one whose entire slice was the filtered base model. Writing the three
 * together is what flips a row onto its own score, so they go in one UPDATE: a row must
 * never rank a slice on a partial formula.
 *
 * Two of the three are plain SQL aggregates over `ModelVersionMetric`. Only the distinct
 * generator count needs ClickHouse, and `uniqMerge` has to group by the (model, base
 * model) pair, so each pair gets an index and `transform()` maps its versions onto that.
 *
 * `publishedAt` is `MIN(ModelVersion."publishedAt")` for the slice — the earliest version
 * of that base model, not the model's own publish date and not its newest version. The
 * migration header says why.
 *
 * Writing the columns fires `trg_base_model_metric_hot_score`, so each batch rescores
 * itself.
 *
 * Resumable, for the same reason as backfill-unique-generators: there are far too many
 * rows for one request. Drive it with `maxModels` and feed `nextStartId` back as
 * `startId` until `done` comes back true.
 *
 * GET/POST /api/admin/temp/backfill-base-model-hot-score?token=$WEBHOOK_TOKEN
 *   batchSize  models per batch (1-5000, default 500)
 *   startId    resume at this modelId (default 0)
 *   maxModels  stop after this many models and report nextStartId (default 0 = all)
 *   dryRun     true = report what would change, write nothing (default false)
 */

const schema = z.object({
  batchSize: z.coerce.number().min(1).max(5000).optional().default(500),
  startId: z.coerce.number().min(0).optional().default(0),
  maxModels: z.coerce.number().min(0).optional().default(0),
  // z.coerce.boolean() treats "false" as true — compare the raw string instead.
  dryRun: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

type Slice = {
  modelId: number;
  baseModel: string;
  generationCount: number;
  publishedAt: Date | null;
  uniqueGeneratorCount: number | null;
};

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { batchSize, startId, maxModels, dryRun } = schema.parse(req.query);
  if (!clickhouse) {
    res.status(500).json({ error: 'ClickHouse client not available' });
    return;
  }

  const started = Date.now();
  // One row past maxModels, so a full page can be told apart from the last one.
  const targets = await pgDbWrite.query<{ modelId: number }>(
    `SELECT DISTINCT "modelId" FROM "ModelBaseModelMetric"
      WHERE "modelId" >= $1 ORDER BY "modelId" ${maxModels ? 'LIMIT $2' : ''}`,
    maxModels ? [startId, maxModels + 1] : [startId]
  );
  const all = targets.rows.map((r) => r.modelId);
  const page = maxModels ? all.slice(0, maxModels) : all;
  const nextStartId = maxModels && all.length > maxModels ? all[maxModels] : null;

  let slicesSeen = 0;
  let withGenerators = 0;
  let rowsUpdated = 0;
  const sample: Slice[] = [];

  for (const [i, ids] of chunk(page, batchSize).entries()) {
    const agg = await pgDbWrite.query<{
      modelId: number;
      baseModel: string;
      generationCount: string;
      publishedAt: Date | null;
    }>(
      `SELECT mv."modelId", mv."baseModel",
              SUM(mvm."generationCount") AS "generationCount",
              MIN(mv."publishedAt") AS "publishedAt"
         FROM "ModelVersionMetric" mvm
         JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
        WHERE mv."modelId" = ANY($1::int[]) AND mv.status = 'Published'
        GROUP BY mv."modelId", mv."baseModel"`,
      [ids]
    );
    if (!agg.rows.length) continue;

    const versions = await pgDbWrite.query<{ id: number; modelId: number; baseModel: string }>(
      `SELECT id, "modelId", "baseModel" FROM "ModelVersion"
        WHERE "modelId" = ANY($1::int[]) AND status = 'Published'`,
      [ids]
    );

    const pairs: string[] = [];
    const versionIds: number[] = [];
    const pairIndexes: number[] = [];
    for (const v of versions.rows) {
      const pair = `${v.modelId}:${v.baseModel}`;
      let idx = pairs.indexOf(pair);
      if (idx < 0) idx = pairs.push(pair) - 1;
      versionIds.push(v.id);
      pairIndexes.push(idx);
    }

    const generators = new Map<string, number>();
    if (versionIds.length) {
      const rows = await clickhouse.$query<{ grp: number; uniqueGenerators: number }>`
        SELECT
          transform(modelVersionId, [${versionIds}], [${pairIndexes}], -1) AS grp,
          uniqMerge(users_state) AS uniqueGenerators
        FROM daily_resource_generation_user_counts
        WHERE modelVersionId IN (${versionIds})
        GROUP BY grp
      `;
      for (const r of rows) {
        const pair = pairs[r.grp];
        if (pair !== undefined) generators.set(pair, Number(r.uniqueGenerators));
      }
    }

    const slices: Slice[] = agg.rows.map((r) => ({
      modelId: r.modelId,
      baseModel: r.baseModel,
      generationCount: parseInt(r.generationCount) || 0,
      publishedAt: r.publishedAt,
      uniqueGeneratorCount: generators.get(`${r.modelId}:${r.baseModel}`) ?? null,
    }));
    slicesSeen += slices.length;
    withGenerators += slices.filter((s) => s.uniqueGeneratorCount !== null).length;
    if (sample.length < 10) sample.push(...slices.slice(0, 10 - sample.length));
    if (dryRun) continue;

    // All three in one UPDATE: a row flips onto its own score only with the full formula.
    // Rows whose generator count is unknown keep uniqueGeneratorCount NULL and stay on the
    // mirrored fallback, which is deliberate.
    const result = await pgDbWrite.query(
      `UPDATE "ModelBaseModelMetric" bm
          SET "generationCount" = v.gen,
              "uniqueGeneratorCount" = v.ug,
              "publishedAt" = v.pub
         FROM (SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::int[], $5::timestamp(3)[])
                      AS t("modelId", "baseModel", gen, ug, pub)) v
        WHERE bm."modelId" = v."modelId"
          AND bm."baseModel" = v."baseModel"
          AND (bm."generationCount" IS DISTINCT FROM v.gen
            OR bm."uniqueGeneratorCount" IS DISTINCT FROM v.ug
            OR bm."publishedAt" IS DISTINCT FROM v.pub)`,
      [
        slices.map((s) => s.modelId),
        slices.map((s) => s.baseModel),
        slices.map((s) => s.generationCount),
        slices.map((s) => s.uniqueGeneratorCount),
        slices.map((s) => s.publishedAt),
      ]
    );
    rowsUpdated += result.rowCount ?? 0;

    if (i % 20 === 0)
      console.log(`backfill-base-model-hot-score: batch ${i + 1}, ${rowsUpdated} rows so far`);
  }

  res.status(200).json({
    dryRun,
    startId,
    nextStartId,
    done: nextStartId === null,
    modelsScanned: page.length,
    slicesSeen,
    slicesWithGenerators: withGenerators,
    rowsUpdated,
    sample,
    seconds: Math.round((Date.now() - started) / 1000),
  });
});
