import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { tagsSearchIndex } from '~/server/search-index';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
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
    await tagsSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
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
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update tag engagement metrics
      INSERT INTO "TagMetric" ("tagId", timeframe, "followerCount", "hiddenCount")
      SELECT
        "tagId",
        tf.timeframe,
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Follow'`)} "followerCount",
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Hide'`)} "hiddenCount"
      FROM "TagEngagement" e
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "tagId" IN (${ids})
      GROUP BY "tagId", tf.timeframe
      ON CONFLICT ("tagId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "hiddenCount" = EXCLUDED."hiddenCount", "updatedAt" = NOW()
    `;
    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

const tagCountMap = {
  Models: { id: 'modelId', table: 'TagsOnModels', column: 'modelCount', sourceTable: 'Model' },
  Images: { id: 'imageId', table: 'TagsOnImage', column: 'imageCount', sourceTable: 'Image' },
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
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 500).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(`get ${table} counts`, i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update tag count metrics
      INSERT INTO "TagMetric" ("tagId", timeframe, "${column}")
      SELECT
        "tagId",
        tf.timeframe,
        ${snippets.timeframeSum('s."createdAt"')}
      FROM "${table}" t
      JOIN "${sourceTable}" s ON s.id = t."${id}"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "tagId" IN (${ids})
      GROUP BY "tagId", tf.timeframe
      ON CONFLICT ("tagId", timeframe) DO UPDATE
        SET "${column}" = EXCLUDED."${column}", "updatedAt" = NOW()
    `;
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
