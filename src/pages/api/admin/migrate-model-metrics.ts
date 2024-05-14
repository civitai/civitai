import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  allInjectedNegatives,
  allInjectedPositives,
} from '~/shared/constants/generation.constants';

const schema = z.object({
  cursor: z.coerce.number().min(0).optional().default(0),
  maxCursor: z.coerce.number().min(0).optional(),
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(0).optional().default(100),
});

const taskGenerators: ((ctx: MigrationContext) => Task)[] = [
  // versionThumbsMetrics,
  // modelThumbsMetrics,
  // modelCollectMetrics,
  modelGenerationMetrics,
];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor, maxCursor } = params;
  const { batchSize, concurrency } = params;
  if (!maxCursor) {
    const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
      SELECT MAX("id") as "maxCursor"
      FROM "Model"
      WHERE status = 'Published';
    `);
    res.on('close', maxCursorQuery.cancel);
    [{ maxCursor }] = await maxCursorQuery.result();
  }
  console.log('Migrating model metrics:', maxCursor);

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  const tasks: Task[] = [];
  while (cursor <= maxCursor) {
    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);
    const ctx = { start, end, stop, cancelFns };

    for (const taskGenerator of taskGenerators) tasks.push(taskGenerator(ctx));
  }

  await limitConcurrency(tasks, concurrency);

  console.log('Migration complete:', maxCursor);
  return res.status(200).json({
    ok: true,
  });
});

type MigrationContext = {
  start: number;
  end: number;
  stop: boolean;
  cancelFns: (() => void)[];
};

function versionThumbsMetrics(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate version thumbs up metrics ' + ctx.start + '-' + ctx.end);
    console.time('Migrate version thumbs up metrics ' + ctx.start + '-' + ctx.end);
    const query = await pgDbWrite.cancellableQuery(`
      -- Migrate model version thumbs up metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "thumbsUpCount", "thumbsDownCount")
      SELECT
        r."modelVersionId",
        tf.timeframe,
        COUNT(DISTINCT CASE
          WHEN NOT recommended THEN NULL
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsUpCount",
        COUNT(DISTINCT CASE
          WHEN recommended THEN NULL
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
      AND r."tosViolation" = FALSE
      AND r."modelId" BETWEEN ${ctx.start} AND ${ctx.end}
      GROUP BY r."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
    `);
    ctx.cancelFns.push(query.cancel);
    await query.result();
    console.timeEnd('Migrate version thumbs up metrics ' + ctx.start + '-' + ctx.end);
  };
}

function modelThumbsMetrics(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate model thumbs up metrics ' + ctx.start + '-' + ctx.end);
    console.time('Migrate model thumbs up metrics ' + ctx.start + '-' + ctx.end);
    const query = await pgDbWrite.cancellableQuery(`
      -- Migrate model thumbs up metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "thumbsUpCount", "thumbsDownCount")
      SELECT
        r."modelId",
        tf.timeframe,
        COUNT(DISTINCT CASE
          WHEN NOT recommended THEN NULL
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsUpCount",
        COUNT(DISTINCT CASE
          WHEN recommended THEN NULL
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
      AND r."tosViolation" = FALSE
      AND r."modelId" BETWEEN ${ctx.start} AND ${ctx.end}
      GROUP BY r."modelId", tf.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
    `);
    ctx.cancelFns.push(query.cancel);
    await query.result();
    console.timeEnd('Migrate model thumbs up metrics ' + ctx.start + '-' + ctx.end);
  };
}

function modelCollectMetrics(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate model collects ' + ctx.start + '-' + ctx.end);
    console.time('Migrate model collects ' + ctx.start + '-' + ctx.end);
    const query = await pgDbWrite.cancellableQuery(`
      -- Migrate model collection metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "collectedCount")
      SELECT
        "modelId",
        timeframe,
        COUNT(DISTINCT CASE
          WHEN timeframe = 'AllTime' THEN c."addedById"
          WHEN timeframe = 'Year' AND c."createdAt" > NOW() - interval '1 year' THEN c."addedById"
          WHEN timeframe = 'Month' AND c."createdAt" > NOW() - interval '1 month' THEN c."addedById"
          WHEN timeframe = 'Week' AND c."createdAt" > NOW() - interval '1 week' THEN c."addedById"
          WHEN timeframe = 'Day' AND c."createdAt" > NOW() - interval '1 day' THEN c."addedById"
        END) as "collectedCount"
      FROM "CollectionItem" c
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE c."modelId" BETWEEN ${ctx.start} AND ${ctx.end}
      GROUP BY "modelId", timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE SET
        "collectedCount" = EXCLUDED."collectedCount",
        "updatedAt" = EXCLUDED."updatedAt";
    `);
    ctx.cancelFns.push(query.cancel);
    await query.result();
    console.timeEnd('Migrate model collects ' + ctx.start + '-' + ctx.end);
  };
}

type GenerationMetrics = {
  modelVersionId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
const injectedVersionIds = [...allInjectedNegatives, ...allInjectedPositives].map((r) => r.id);
function modelGenerationMetrics(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop || !clickhouse) return;
    const getVersionsQuery = await pgDbWrite.cancellableQuery<{ id: number }>(`
      SELECT id
      FROM "ModelVersion"
      WHERE "modelId" BETWEEN ${ctx.start} AND ${ctx.end}
    `);
    ctx.cancelFns.push(getVersionsQuery.cancel);
    const versions = await getVersionsQuery.result();
    const versionIds = versions.map((v) => v.id).filter((id) => !injectedVersionIds.includes(id));
    if (!versionIds.length) return;

    console.log('Update model generation metrics ' + ctx.start + '-' + ctx.end);
    console.time('Fetch version generation metrics ' + ctx.start + '-' + ctx.end);
    const metrics = await clickhouse.$query<GenerationMetrics>`
      SELECT
        modelVersionId,
        countIf(date = current_date()) day,
        countIf(date >= subtractDays(current_date(), 7)) week,
        countIf(date >= subtractMonths(current_date(), 1)) month,
        countIf(date >= subtractYears(current_date(), 1)) year,
        count(*) all_time
      FROM daily_user_resource
      WHERE modelVersionId IN (${versionIds})
      GROUP BY modelVersionId;
    `;
    const metricsJson = JSON.stringify(metrics);
    console.timeEnd('Fetch version generation metrics ' + ctx.start + '-' + ctx.end);

    console.time('Update version generation metrics ' + ctx.start + '-' + ctx.end);
    const versionQuery = await pgDbWrite.cancellableQuery(`
      -- Update model generation metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "generationCount")
      SELECT
          mvm.modelVersionId, mvm.timeframe, mvm.generations
      FROM
      (
          SELECT
              CAST(mvs::json->>'modelVersionId' AS INT) AS modelVersionId,
              tf.timeframe,
              CAST(
                CASE
                  WHEN tf.timeframe = 'Day' THEN mvs::json->>'day'
                  WHEN tf.timeframe = 'Week' THEN mvs::json->>'week'
                  WHEN tf.timeframe = 'Month' THEN mvs::json->>'month'
                  WHEN tf.timeframe = 'Year' THEN mvs::json->>'year'
                  WHEN tf.timeframe = 'AllTime' THEN mvs::json->>'all_time'
                END
              AS int) as generations
          FROM json_array_elements('${metricsJson}'::json) mvs
          CROSS JOIN (
              SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
      ) mvm
      WHERE
        mvm.generations IS NOT NULL
        AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion") -- Exists
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "generationCount" = EXCLUDED."generationCount", "updatedAt" = now();
    `);
    ctx.cancelFns.push(versionQuery.cancel);
    await versionQuery.result();
    console.timeEnd('Update version generation metrics ' + ctx.start + '-' + ctx.end);

    console.time('Update model generation metrics ' + ctx.start + '-' + ctx.end);
    const modelQuery = await pgDbWrite.cancellableQuery(`
      -- Update model generation metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "generationCount", "updatedAt")
      SELECT
        mv."modelId",
        mvm.timeframe,
        SUM(mvm."generationCount") "generationCount",
        NOW() "updatedAt"
      FROM "ModelVersionMetric" mvm
      JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
      WHERE mv."modelId" BETWEEN ${ctx.start} AND ${ctx.end}
      GROUP BY mv."modelId", mvm.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE SET
        "generationCount" = EXCLUDED."generationCount",
        "updatedAt" = EXCLUDED."updatedAt";
    `);
    ctx.cancelFns.push(modelQuery.cancel);
    await modelQuery.result();
    console.timeEnd('Update model generation metrics ' + ctx.start + '-' + ctx.end);
  };
}
