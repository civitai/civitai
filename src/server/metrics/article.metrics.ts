import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { articlesSearchIndex } from '~/server/search-index';
import { createLogger } from '~/utils/logging';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { executeRefresh, getAffected } from '~/server/metrics/metric-helpers';
import { articleStatCache } from '~/server/redis/caches';
import type { ArticleMetric } from '~/shared/utils/prisma/models';
import { templateHandler } from '~/server/db/db-helpers';

const log = createLogger('metrics:article');

export const articleMetrics = createMetricProcessor({
  name: 'Article',
  async update(baseCtx) {
    // Update the context to include the update record
    const ctx = baseCtx as MetricContext;
    ctx.updates = {};

    // Get the metric tasks
    //---------------------------------------
    const fetchTasks = (await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      getEngagementTasks(ctx),
      getViewTasks(ctx),
    ]).then((x) => x.flat())) as Task[];
    log('articleMetrics update', fetchTasks.length, 'tasks');
    await limitConcurrency(fetchTasks, 5);

    // Update the article metrics
    //---------------------------------------
    const metricInsertColumns = metrics.map((key) => `"${key}" INT`).join(', ');
    const metricInsertKeys = metrics.map((key) => `"${key}"`).join(', ');
    const metricValues = metrics
      .map((key) => `COALESCE(d."${key}", im."${key}", 0) as "${key}"`)
      .join(',\n');
    const metricOverrides = metrics.map((key) => `"${key}" = EXCLUDED."${key}"`).join(',\n');

    const updateTasks = chunk(Object.values(ctx.updates), 100).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', updateTasks.length);
      await executeRefresh(ctx)`
        -- update article metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("articleId" INT, ${metricInsertColumns}))
        INSERT INTO "ArticleMetric" ("articleId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."articleId",
          'AllTime'::"MetricTimeframe" AS timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "ArticleMetric" im ON im."articleId" = d."articleId" AND im."timeframe" = 'AllTime'
        WHERE EXISTS (SELECT 1 FROM "Article" WHERE id = d."articleId") -- ensure the article exists
        ON CONFLICT ("articleId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
      `;
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

    // Update the search index
    //---------------------------------------
    const affectedArticleIds = Object.keys(ctx.updates).map((id) => parseInt(id, 10));
    log('update search index', affectedArticleIds.length, 'articles');
    await articlesSearchIndex.queueUpdate(
      affectedArticleIds.map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );

    // Bust article stat cache for all affected articles
    //---------------------------------------
    log('bust article stat cache', affectedArticleIds.length, 'articles');
    if (affectedArticleIds.length > 0) {
      await articleStatCache.bust(affectedArticleIds);
    }
  },
  rank: {
    table: 'ArticleRank',
    primaryKey: 'articleId',
    indexes: ['reactionCountMonthRank'],
  },
});

async function getReactionTasks(ctx: MetricContext) {
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
    await getMetrics(ctx)`
      -- get article reaction metrics
      SELECT
        r."articleId",
        'AllTime'::"MetricTimeframe" AS timeframe,
        SUM(CASE WHEN r.reaction = 'Heart' THEN 1 ELSE 0 END)::int AS "heartCount",
        SUM(CASE WHEN r.reaction = 'Like' THEN 1 ELSE 0 END)::int AS "likeCount",
        SUM(CASE WHEN r.reaction = 'Dislike' THEN 1 ELSE 0 END)::int AS "dislikeCount",
        SUM(CASE WHEN r.reaction = 'Laugh' THEN 1 ELSE 0 END)::int AS "laughCount",
        SUM(CASE WHEN r.reaction = 'Cry' THEN 1 ELSE 0 END)::int AS "cryCount"
      FROM "ArticleReaction" r
      WHERE r."articleId" IN (${ids})
        AND r."articleId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY r."articleId"
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricContext) {
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
    await getMetrics(ctx)`
      -- get article comment metrics
      SELECT
        t."articleId",
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(c.id)::int AS "commentCount"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."articleId" IN (${ids})
        AND t."articleId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."articleId"
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent article collections
    SELECT "articleId" as id
    FROM "CollectionItem"
    WHERE "articleId" IS NOT NULL AND "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get article collection metrics
      SELECT
        ci."articleId",
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(ci.id)::int AS "collectedCount"
      FROM "CollectionItem" ci
      WHERE ci."articleId" IN (${ids})
        AND ci."articleId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY ci."articleId"
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent article tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Article' AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get article tip metrics
      SELECT
        bt."entityId" AS "articleId",
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(*)::int AS "tippedCount",
        SUM(bt.amount)::int AS "tippedAmountCount"
      FROM "BuzzTip" bt
      WHERE bt."entityId" IN (${ids})
        AND bt."entityId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        AND bt."entityType" = 'Article'
      GROUP BY bt."entityId"
    `;
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getEngagementTasks(ctx: MetricContext) {
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
    await getMetrics(ctx)`
      -- get article engagement metrics
      SELECT
        ae."articleId",
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(ae.id)::int AS "hideCount"
      FROM "ArticleEngagement" ae
      WHERE ae."articleId" IN (${ids})
        AND ae."articleId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        AND ae.type = 'Hide'
      GROUP BY ae."articleId"
    `;
    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type ArticleViews = {
  entityId: number;
  all_time: number;
};
async function getViewTasks(ctx: MetricContext) {
  const viewed = await ctx.ch.$query<ArticleViews>`
    SELECT
      entityId,
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

  const tasks = chunk(viewed, 1000).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getViewTasks', i + 1, 'of', tasks.length);

    // Add view metrics to ctx.updates
    for (const row of batch) {
      const articleId = row.entityId;
      ctx.updates[articleId] ??= { articleId } as Record<MetricKey, number>;
      ctx.updates[articleId].viewCount = Number(row.all_time);
    }

    log('getViewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type MetricKey = keyof ArticleMetric;
type MetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<MetricKey, number>>;
};
const metrics = [
  'heartCount',
  'likeCount',
  'dislikeCount',
  'laughCount',
  'cryCount',
  'commentCount',
  'viewCount',
  'hideCount',
  'collectedCount',
  'tippedCount',
  'tippedAmountCount',
] as const;

function getMetrics(ctx: MetricContext) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<ArticleMetric>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();
    if (!data.length) return;

    for (const row of data) {
      const articleId = row.articleId;
      ctx.updates[articleId] ??= { articleId } as Record<MetricKey, number>;
      for (const key of Object.keys(row) as MetricKey[]) {
        if (key === 'articleId' || key === 'timeframe') continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[articleId][key] = Number(value);
      }
    }
  });
}
