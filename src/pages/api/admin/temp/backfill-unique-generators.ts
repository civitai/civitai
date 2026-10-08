import type { NextApiRequest, NextApiResponse } from 'next';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * One-off population of `ModelMetric.uniqueGeneratorCount`, which caps the hot
 * score's generation term (migration 20261011120000).
 *
 * The migration cannot do this itself: the source is a ClickHouse materialized
 * view and Postgres cannot read it. Until the column is populated the cap is
 * inert, so a model can still carry a score built on one person's generations.
 *
 * The count is merged across a model's versions, never summed — anyone who used
 * two versions of the same model is one generator. `transform()` maps each
 * version back to its model and `uniqMerge` collapses the uniq states, which is
 * the same shape the going-forward metrics task uses.
 *
 * Writing the column fires `trg_model_metric_hot_score`, so each batch recomputes
 * its own scores. Nothing else has to run afterwards.
 *
 * Idempotent: re-running writes the same values, and `WHERE ... IS DISTINCT FROM`
 * means a second pass touches nothing and recomputes nothing.
 *
 * RESUMABLE, because it has to be. There are hundreds of thousands of models to
 * cover and every ingress in front of this will cut the connection long before a
 * single pass finishes. A killed request keeps the batches it already committed but
 * restarts from the first model, so without paging the run never converges. Drive it
 * with `maxModels` and feed `nextStartId` back as `startId` until it comes back null.
 *
 * GET/POST /api/admin/temp/backfill-unique-generators?token=$WEBHOOK_TOKEN
 *   batchSize  models per batch (1-20000, default 5000)
 *   minGens    only models with at least this many generations (default 1).
 *              Raise it to do the models that can actually be inflated first.
 *   startId    resume at this modelId (default 0)
 *   maxModels  stop after this many models and report nextStartId (default 0 = all)
 *   dryRun     true = report what would change, write nothing (default false)
 */

const schema = z.object({
  batchSize: z.coerce.number().min(1).max(20000).optional().default(5000),
  minGens: z.coerce.number().min(0).optional().default(1),
  startId: z.coerce.number().min(0).optional().default(0),
  maxModels: z.coerce.number().min(0).optional().default(0),
  // z.coerce.boolean() treats "false" as true — compare the raw string instead.
  dryRun: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { batchSize, minGens, startId, maxModels, dryRun } = schema.parse(req.query);
  if (!clickhouse) {
    res.status(500).json({ error: 'ClickHouse client not available' });
    return;
  }

  const started = Date.now();
  // One row past maxModels, so a full page can be told apart from the last one.
  const targets = await pgDbWrite.query<{ modelId: number }>(
    `SELECT "modelId" FROM "ModelMetric"
       WHERE "generationCount" >= $1 AND "modelId" >= $2
       ORDER BY "modelId" ${maxModels ? 'LIMIT $3' : ''}`,
    maxModels ? [minGens, startId, maxModels + 1] : [minGens, startId]
  );
  const all = targets.rows.map((r) => r.modelId);
  const page = maxModels ? all.slice(0, maxModels) : all;
  const nextStartId = maxModels && all.length > maxModels ? all[maxModels] : null;
  const batches = chunk(page, batchSize);

  let scanned = 0;
  let updated = 0;
  let withGenerators = 0;
  const sample: { modelId: number; uniqueGenerators: number }[] = [];

  for (const [i, ids] of batches.entries()) {
    const versions = await pgDbWrite.query<{ id: number; modelId: number }>(
      `SELECT id, "modelId" FROM "ModelVersion" WHERE "modelId" = ANY($1::int[])`,
      [ids]
    );
    scanned += ids.length;
    if (!versions.rows.length) continue;

    const versionIds = versions.rows.map((v) => v.id);
    const modelIds = versions.rows.map((v) => v.modelId);
    const counts = await clickhouse.$query<{ modelId: number; uniqueGenerators: number }>`
      SELECT
        transform(modelVersionId, [${versionIds}], [${modelIds}], 0) AS modelId,
        uniqMerge(users_state) AS uniqueGenerators
      FROM daily_resource_generation_user_counts
      WHERE modelVersionId IN (${versionIds})
      GROUP BY modelId
    `;

    const rows = counts.filter((r) => r.modelId && Number(r.uniqueGenerators) > 0);
    withGenerators += rows.length;
    if (sample.length < 10)
      sample.push(
        ...rows.slice(0, 10 - sample.length).map((r) => ({
          modelId: r.modelId,
          uniqueGenerators: Number(r.uniqueGenerators),
        }))
      );
    if (dryRun || !rows.length) continue;

    // IS DISTINCT FROM keeps a re-run from firing the trigger on rows that already
    // hold the right value, so a second pass costs seconds instead of minutes.
    const result = await pgDbWrite.query(
      `UPDATE "ModelMetric" mm
          SET "uniqueGeneratorCount" = v.count
         FROM (SELECT * FROM unnest($1::int[], $2::int[]) AS t("modelId", count)) v
        WHERE mm."modelId" = v."modelId"
          AND mm."uniqueGeneratorCount" IS DISTINCT FROM v.count`,
      [rows.map((r) => r.modelId), rows.map((r) => Number(r.uniqueGenerators))]
    );
    updated += result.rowCount ?? 0;

    if (i % 20 === 0) console.log(`backfill-unique-generators: batch ${i + 1}/${batches.length}`);
  }

  res.status(200).json({
    dryRun,
    minGens,
    startId,
    nextStartId,
    done: nextStartId === null,
    batches: batches.length,
    modelsScanned: scanned,
    modelsWithGenerators: withGenerators,
    rowsUpdated: updated,
    sample,
    seconds: Math.round((Date.now() - started) / 1000),
  });
});
