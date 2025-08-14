import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  executeRefresh,
  executeRefreshWithParams,
  getAffected,
  getMetricJson,
  snippets,
} from '~/server/metrics/metric-helpers';
import { chunk } from 'lodash-es';

const log = createLogger('metrics:tag');

export const tagMetrics = createMetricProcessor({
  name: 'Tag',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getEngagementTasks(ctx),
      getModelTasks(ctx),
      // getImageTasks(ctx), // This is too heavy
      getPostTasks(ctx),
      getArticleTasks(ctx),
    ]);
    log('tagMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
  },
  async clearDay(ctx) {
    await executeRefresh(ctx)`
      UPDATE "TagMetric"
        SET "followerCount" = 0, "modelCount" = 0, "hiddenCount" = 0, "postCount" = 0, "imageCount" = 0, "articleCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'TagRank',
    primaryKey: 'tagId',
    refreshInterval: 5 * 60 * 1000,
  },
});

async function getEngagementTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent tag engagements
    SELECT
      "tagId" as id
    FROM "TagEngagement"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking - only get total counts
    const metrics = await getMetricJson(ctx)`
      -- Aggregate tag engagement metrics into JSON (AllTime counts only)
      WITH counts AS (
        SELECT
          "tagId",
          SUM(CASE WHEN type = 'Follow' THEN 1 ELSE 0 END) as "followerCount",
          SUM(CASE WHEN type = 'Hide' THEN 1 ELSE 0 END) as "hiddenCount"
        FROM "TagEngagement"
        WHERE "tagId" = ANY(${ids}::int[])
        GROUP BY "tagId"
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'tagId', "tagId",
          'followerCount', "followerCount",
          'hiddenCount', "hiddenCount"
        )
      ) as data
      FROM counts
    `;

    // Then perform the insert from the aggregated data with CROSS JOIN for all timeframes
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert tag engagement metrics for all timeframes using the AllTime counts
        INSERT INTO "TagMetric" ("tagId", timeframe, "followerCount", "hiddenCount")
        SELECT
          (value->>'tagId')::int,
          tf.timeframe,
          (value->>'followerCount')::int,
          (value->>'hiddenCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        ON CONFLICT ("tagId", timeframe) DO UPDATE
          SET "followerCount" = EXCLUDED."followerCount",
              "hiddenCount" = EXCLUDED."hiddenCount",
              "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

const tagCountMap = {
  Models: { id: 'modelId', table: 'TagsOnModels', column: 'modelCount', sourceTable: 'Model' },
  Images: {
    id: 'imageId',
    table: 'TagsOnImageDetails',
    column: 'imageCount',
    sourceTable: 'Image',
  },
  Posts: { id: 'postId', table: 'TagsOnPost', column: 'postCount', sourceTable: 'Post' },
  Articles: {
    id: 'articleId',
    table: 'TagsOnArticle',
    column: 'articleCount',
    sourceTable: 'Article',
  },
} as const;
async function getTagCountTasks(ctx: MetricProcessorRunContext, entity: keyof typeof tagCountMap) {
  const { id, table, column, sourceTable } = tagCountMap[entity];
  const affected = await getAffected(ctx)`
    -- get recent tag counts
    SELECT
      "tagId" AS id
    FROM "${table}"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 500).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(`get ${table} counts`, i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking - only get total count
    const metrics = await getMetricJson(ctx)`
      -- Aggregate tag count metrics into JSON (AllTime count only)
      WITH counts AS (
        SELECT
          "tagId",
          COUNT(1) as "count"
        FROM "${table}" t
        JOIN "${sourceTable}" s ON s.id = t."${id}"
        WHERE "tagId" = ANY(${ids}::int[])
        GROUP BY "tagId"
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'tagId', "tagId",
          'count', "count"
        )
      ) as data
      FROM counts
    `;

    // Then perform the insert from the aggregated data with CROSS JOIN for all timeframes
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert tag count metrics for all timeframes using the AllTime count
        INSERT INTO "TagMetric" ("tagId", timeframe, "${column}")
        SELECT
          (value->>'tagId')::int,
          tf.timeframe,
          (value->>'count')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        ON CONFLICT ("tagId", timeframe) DO UPDATE
          SET "${column}" = EXCLUDED."${column}", "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log(`get ${table} counts`, i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getModelTasks(ctx: MetricProcessorRunContext) {
  return getTagCountTasks(ctx, 'Models');
}

async function getImageTasks(ctx: MetricProcessorRunContext) {
  return getTagCountTasks(ctx, 'Images');
}

async function getPostTasks(ctx: MetricProcessorRunContext) {
  return getTagCountTasks(ctx, 'Posts');
}

async function getArticleTasks(ctx: MetricProcessorRunContext) {
  return getTagCountTasks(ctx, 'Articles');
}
