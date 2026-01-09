import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { articlesSearchIndex } from '~/server/search-index';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  executeRefresh,
  executeRefreshWithParams,
  getAffected,
  getMetricJson,
  snippets,
} from '~/server/metrics/metric-helpers';
import { articleStatCache } from '~/server/redis/caches';

const log = createLogger('metrics:article');

export const articleMetrics = createMetricProcessor({
  name: 'Article',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      getEngagementTasks(ctx),
      getViewTasks(ctx),
    ]);
    log('articleMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await articlesSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );

    // Bust article stat cache for all affected articles
    //---------------------------------------
    log('bust article stat cache', ctx.affected.size, 'articles');
    await articleStatCache.bust([...ctx.affected]);
  },
  // Not using day metrics anymore
  // async clearDay(ctx) {
  //   await executeRefresh(ctx)`
  //     UPDATE "ArticleMetric"
  //       SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "viewCount" = 0, "collectedCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0
  //     WHERE timeframe = 'Day'
  //       AND "updatedAt" > date_trunc('day', now() - interval '1 day');
  //   `;
  // },
  rank: {
    table: 'ArticleRank',
    primaryKey: 'articleId',
    indexes: ['reactionCountMonthRank'],
  },
});

async function getReactionTasks(ctx: MetricProcessorRunContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affected = await getAffected(ctx)`
    -- get recent article reactions
    SELECT
      "articleId" AS id
    FROM "ArticleReaction"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate article reaction metrics into JSON
      WITH metric_data AS (
        SELECT
          r."articleId",
          tf.timeframe,
          ${snippets.reactionTimeframes()}
        FROM "ArticleReaction" r
        JOIN "Article" a ON a.id = r."articleId" -- ensure the article exists
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE r."articleId" = ANY(${ids}::int[])
        GROUP BY r."articleId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'articleId', "articleId",
          'timeframe', timeframe,
          'heartCount', "heartCount",
          'likeCount', "likeCount",
          'dislikeCount', "dislikeCount",
          'laughCount', "laughCount",
          'cryCount', "cryCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated article reaction metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, ${snippets.reactionMetricNames})
        SELECT
          (value->>'articleId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'heartCount')::int,
          (value->>'likeCount')::int,
          (value->>'dislikeCount')::int,
          (value->>'laughCount')::int,
          (value->>'cryCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET ${snippets.reactionMetricUpserts}, "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent article comments
    SELECT t."articleId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."articleId" IS NOT NULL AND c."createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate article comment metrics into JSON
      WITH metric_data AS (
        SELECT
          t."articleId",
          tf.timeframe,
          ${snippets.timeframeSum('c."createdAt"')} as "commentCount"
        FROM "Thread" t
        JOIN "Article" a ON a.id = t."articleId" -- ensure the article exists
        JOIN "CommentV2" c ON c."threadId" = t.id
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE t."articleId" = ANY(${ids}::int[])
        GROUP BY t."articleId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'articleId', "articleId",
          'timeframe', timeframe,
          'commentCount', "commentCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated article comment metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, "commentCount")
        SELECT
          (value->>'articleId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'commentCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent article collections
    SELECT "articleId" as id
    FROM "CollectionItem"
    WHERE "articleId" IS NOT NULL AND "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate article collection metrics into JSON
      WITH metric_data AS (
        SELECT
          "articleId",
          tf.timeframe,
          ${snippets.timeframeSum('ci."createdAt"')} as "collectedCount"
        FROM "CollectionItem" ci
        JOIN "Article" a ON a.id = ci."articleId" -- ensure the article exists
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE ci."articleId" = ANY(${ids}::int[])
        GROUP BY ci."articleId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'articleId', "articleId",
          'timeframe', timeframe,
          'collectedCount', "collectedCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated article collection metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, "collectedCount")
        SELECT
          (value->>'articleId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'collectedCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent article tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Article' AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate article tip metrics into JSON
      WITH metric_data AS (
        SELECT
          "entityId",
          tf.timeframe,
          ${snippets.timeframeSum('bt."updatedAt"')} "tippedCount",
          ${snippets.timeframeSum('bt."updatedAt"', 'amount')} "tippedAmountCount"
        FROM "BuzzTip" bt
        JOIN "Article" a ON a.id = bt."entityId" -- ensure the article exists
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE "entityId" = ANY(${ids}::int[]) AND "entityType" = 'Article'
        GROUP BY "entityId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'articleId', "entityId",
          'timeframe', timeframe,
          'tippedCount', "tippedCount",
          'tippedAmountCount', "tippedAmountCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated article tip metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, "tippedCount", "tippedAmountCount")
        SELECT
          (value->>'articleId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'tippedCount')::int,
          (value->>'tippedAmountCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getEngagementTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent article engagements
    SELECT
      "articleId" as id
    FROM "ArticleEngagement"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate article engagement metrics into JSON
      WITH metric_data AS (
        SELECT
          "articleId",
          tf.timeframe,
          ${snippets.timeframeSum('ae."createdAt"')} "hideCount"
        FROM "ArticleEngagement" ae
        JOIN "Article" a ON a.id = ae."articleId" -- ensure the article exists
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE "articleId" = ANY(${ids}::int[]) AND ae.type = 'Hide'
        GROUP BY "articleId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'articleId', "articleId",
          'timeframe', timeframe,
          'hideCount', "hideCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated article engagement metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, "hideCount")
        SELECT
          (value->>'articleId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'hideCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET "hideCount" = EXCLUDED."hideCount", "updatedAt" = NOW()`,
        [JSON.stringify(metrics)]
      );
    }

    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type ArticleViews = {
  entityId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
async function getViewTasks(ctx: MetricProcessorRunContext) {
  const viewed = await ctx.ch.$query<ArticleViews>`
    SELECT
      entityId,
      sumIf(view_count, date >= toDate(subtractDays(now(), 1))) AS day,
      sumIf(view_count, date >= toDate(subtractDays(now(), 7))) AS week,
      sumIf(view_count, date >= toDate(subtractMonths(now(), 1))) AS month,
      sumIf(view_count, date >= toDate(subtractYears(now(), 1))) AS year,
      sum(view_count) AS all_time
    FROM uniqueViewsDaily
    WHERE type = 'ArticleView'
      AND entityId IN (
        SELECT entityId
        FROM views
        WHERE type = 'ArticleView'
          AND time >= ${ctx.lastUpdate}
        GROUP BY entityId
      )
    GROUP BY entityId;
  `;
  ctx.addAffected(viewed.map((x) => x.entityId));

  const tasks = chunk(viewed, 1000).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getViewTasks', i + 1, 'of', tasks.length);
    try {
      const batchJson = JSON.stringify(batch);
      await executeRefresh(ctx)`
        -- update article view metrics
        INSERT INTO "ArticleMetric" ("articleId", timeframe, "viewCount")
        SELECT
          "articleId",
            timeframe,
            views
        FROM (
            SELECT
                CAST(js::json->>'entityId' AS INT) AS "articleId",
                tf.timeframe,
                CAST(
                  CASE
                    WHEN tf.timeframe = 'Day' THEN js::json->>'day'
                    WHEN tf.timeframe = 'Week' THEN js::json->>'week'
                    WHEN tf.timeframe = 'Month' THEN js::json->>'month'
                    WHEN tf.timeframe = 'Year' THEN js::json->>'year'
                    WHEN tf.timeframe = 'AllTime' THEN js::json->>'all_time'
                  END
                AS int) as views
            FROM json_array_elements('${batchJson}'::json) js
            CROSS JOIN (
                SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
            ) tf
        ) a
        WHERE a.views IS NOT NULL
          AND a."articleId" IN (SELECT id FROM "Article")
        ON CONFLICT ("articleId", timeframe) DO UPDATE
          SET "viewCount" = EXCLUDED."viewCount",
              "updatedAt" = NOW();
      `;
    } catch (err) {
      throw err;
    }
    log('getViewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
