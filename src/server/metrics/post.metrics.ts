import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:post');

export const postMetrics = createMetricProcessor({
  name: 'Post',
  async update(ctx) {
    const tasks = (await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
    ]).then((x) => x.flat())) as Task[];
    log('postMetrics update', tasks.length, 'tasks');
    await limitConcurrency(tasks, 5);
  },
  async clearDay({ pg, jobContext }) {
    log('clearDay');
    const query = await pg.cancellableQuery(Prisma.sql`
      UPDATE "PostMetric" SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0 WHERE timeframe = 'Day' AND "createdAt" > date_trunc('day', now() - interval '1 day');
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
  },
  rank: {
    table: 'PostRank',
    primaryKey: 'postId',
    indexes: [
      'reactionCountAllTimeRank',
      'reactionCountDayRank',
      'reactionCountWeekRank',
      'reactionCountMonthRank',
      'reactionCountYearRank',
      'commentCountAllTimeRank',
      'commentCountDayRank',
      'commentCountWeekRank',
      'commentCountMonthRank',
      'commentCountYearRank',
      'collectedCountAllTimeRank',
      'collectedCountDayRank',
      'collectedCountWeekRank',
      'collectedCountMonthRank',
      'collectedCountYearRank',
    ],
  },
});

async function getReactionTasks({ pg, lastUpdate, jobContext }: MetricProcessorRunContext) {
  log('getReactionTasks', lastUpdate);
  const affectedQuery = await pg.cancellableQuery<{ id: number }>(Prisma.sql`
    -- get recent post image reactions
    SELECT DISTINCT
      i."postId" AS id
    FROM "ImageReaction" ir
    JOIN "Image" i ON i.id = ir."imageId"
    WHERE ir."createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Post'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const affectedIds = affected.map((x) => x.id);

  const tasks = chunk(affectedIds, 100).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update post reaction metrics
      INSERT INTO "PostMetric" ("postId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount")
      SELECT
        i."postId",
        tf.timeframe,
        SUM(CASE
          WHEN ir.reaction = 'Like' AND tf.timeframe = 'AllTime' THEN 1
          WHEN ir.reaction = 'Like' AND tf.timeframe = 'Year' AND ir."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN ir.reaction = 'Like' AND tf.timeframe = 'Month' AND ir."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN ir.reaction = 'Like' AND tf.timeframe = 'Week' AND ir."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN ir.reaction = 'Like' AND tf.timeframe = 'Day' AND ir."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "likeCount",
        SUM(CASE
          WHEN ir.reaction = 'Dislike' AND tf.timeframe = 'AllTime' THEN 1
          WHEN ir.reaction = 'Dislike' AND tf.timeframe = 'Year' AND ir."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN ir.reaction = 'Dislike' AND tf.timeframe = 'Month' AND ir."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN ir.reaction = 'Dislike' AND tf.timeframe = 'Week' AND ir."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN ir.reaction = 'Dislike' AND tf.timeframe = 'Day' AND ir."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "dislikeCount",
        SUM(CASE
          WHEN ir.reaction = 'Heart' AND tf.timeframe = 'AllTime' THEN 1
          WHEN ir.reaction = 'Heart' AND tf.timeframe = 'Year' AND ir."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN ir.reaction = 'Heart' AND tf.timeframe = 'Month' AND ir."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN ir.reaction = 'Heart' AND tf.timeframe = 'Week' AND ir."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN ir.reaction = 'Heart' AND tf.timeframe = 'Day' AND ir."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "heartCount",
        SUM(CASE
          WHEN ir.reaction = 'Laugh' AND tf.timeframe = 'AllTime' THEN 1
          WHEN ir.reaction = 'Laugh' AND tf.timeframe = 'Year' AND ir."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN ir.reaction = 'Laugh' AND tf.timeframe = 'Month' AND ir."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN ir.reaction = 'Laugh' AND tf.timeframe = 'Week' AND ir."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN ir.reaction = 'Laugh' AND tf.timeframe = 'Day' AND ir."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "laughCount",
        SUM(CASE
          WHEN ir.reaction = 'Cry' AND tf.timeframe = 'AllTime' THEN 1
          WHEN ir.reaction = 'Cry' AND tf.timeframe = 'Year' AND ir."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN ir.reaction = 'Cry' AND tf.timeframe = 'Month' AND ir."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN ir.reaction = 'Cry' AND tf.timeframe = 'Week' AND ir."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN ir.reaction = 'Cry' AND tf.timeframe = 'Day' AND ir."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "cryCount"
      FROM "ImageReaction" ir
      JOIN "Image" i ON i.id = ir."imageId"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE i."postId" IN (${Prisma.join(ids)})
      GROUP BY i."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks({ pg, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const affectedQuery = await pg.cancellableQuery(Prisma.sql`
    -- get recent post comments
    SELECT DISTINCT
      t."postId" AS id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."postId" IS NOT NULL AND c."createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Post'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const affectedIds = affected.map((x) => x.id);

  const tasks = chunk(affectedIds, 100).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update post comment counts
      INSERT INTO "PostMetric" ("postId", timeframe, "commentCount")
      SELECT
        ic."postId",
        tf.timeframe,
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN 1
          WHEN tf.timeframe = 'Year' AND v."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN tf.timeframe = 'Month' AND v."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN tf.timeframe = 'Week' AND v."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN tf.timeframe = 'Day' AND v."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END)
      FROM "Thread" ic
      JOIN "CommentV2" v ON ic."id" = v."threadId"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE ic."postId" IS NOT NULL AND ic."postId" IN (${Prisma.join(ids)})
      GROUP BY ic."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks({ pg, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const affectedQuery = await pg.cancellableQuery(Prisma.sql`
    -- get recent post collections
    SELECT DISTINCT
      "postId" AS id
    FROM "CollectionItem"
    WHERE "createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Post'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const affectedIds = affected.map((x) => x.id);

  const tasks = chunk(affectedIds, 100).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update post collection counts
      INSERT INTO "PostMetric" ("postId", timeframe, "collectedCount")
      SELECT
        pci."postId",
        tf.timeframe,
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN 1
          WHEN tf.timeframe = 'Year' AND pci."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN tf.timeframe = 'Month' AND pci."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN tf.timeframe = 'Week' AND pci."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN tf.timeframe = 'Day' AND pci."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END)
      FROM "CollectionItem" pci
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE pci."postId" IS NOT NULL AND pci."postId" IN (${Prisma.join(ids)})
      GROUP BY pci."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET "collectedCount" = EXCLUDED."collectedCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
