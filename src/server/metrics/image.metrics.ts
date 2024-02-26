import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { Prisma, SearchIndexUpdateQueueAction } from '@prisma/client';
import { imagesSearchIndex } from '~/server/search-index';
import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:post');

type ImageMetricContext = MetricProcessorRunContext & {
  addAffected: (id: number | number[]) => void;
};

export const imageMetrics = createMetricProcessor({
  name: 'Image',
  async update(ctx) {
    // Prepare the context
    const { pg, jobContext } = ctx;
    const imageCtx = ctx as ImageMetricContext;
    const affected = new Set<number>();
    imageCtx.addAffected = (id) => {
      if (Array.isArray(id)) id.forEach((x) => affected.add(x));
      else affected.add(id);
    };

    // Get the metric tasks
    //---------------------------------------
    // Get the tasks for reactions, comments, collections, and buzz
    const tasks = (await Promise.all([
      getReactionTasks(imageCtx),
      getCommentTasks(imageCtx),
      getCollectionTasks(imageCtx),
      getBuzzTasks(imageCtx),
    ]).then((x) => x.flat())) as Task[];
    log('imageMetrics update', tasks.length, 'tasks');
    await limitConcurrency(tasks, 5);

    // Get the tasks for views
    const viewTasks = await getViewTasks(imageCtx);
    await limitConcurrency(viewTasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await imagesSearchIndex.queueUpdate(
      [...affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );

    // Update the age group of the metrics
    //---------------------------------------
    log('update age groups');
    const updateAgeGroupsQuery = await pg.cancellableQuery(Prisma.sql`
      UPDATE "ImageMetric"
      SET "ageGroup" = CASE
          WHEN "createdAt" >= now() - interval '1 day' THEN 'Day'::"MetricTimeframe"
          WHEN "createdAt" >= now() - interval '1 week' THEN 'Week'::"MetricTimeframe"
          WHEN "createdAt" >= now() - interval '1 month' THEN 'Month'::"MetricTimeframe"
          WHEN "createdAt" >= now() - interval '1 year' THEN 'Year'::"MetricTimeframe"
          ELSE 'AllTime'::"MetricTimeframe"
      END
      WHERE
        ("ageGroup" = 'Year' AND "createdAt" < now() - interval '1 year') OR
        ("ageGroup" = 'Month' AND "createdAt" < now() - interval '1 month') OR
        ("ageGroup" = 'Week' AND "createdAt" < now() - interval '1 week') OR
        ("ageGroup" = 'Day' AND "createdAt" < now() - interval '1 day');
    `);
    jobContext.on('cancel', updateAgeGroupsQuery.cancel);
    await updateAgeGroupsQuery.result();
  },
  async clearDay({ pg, jobContext }) {
    // Clear day of things updated in the last day
    const clearDayQuery = await pg.cancellableQuery(Prisma.sql`
      UPDATE "ImageMetric" SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0 WHERE timeframe = 'Day' AND "createdAt" > date_trunc('day', now() - interval '1 day');
    `);
    jobContext.on('cancel', clearDayQuery.cancel);
    await clearDayQuery.result();
  },
});

async function getReactionTasks({ pg, lastUpdate, jobContext, ...ctx }: ImageMetricContext) {
  log('getReactionTasks', lastUpdate);
  const affectedQuery = await pg.cancellableQuery<{ id: number }>(Prisma.sql`
    -- get recent image reactions
    SELECT
      "imageId" AS id
    FROM "ImageReaction"
    WHERE "createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Image'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const ids = [...new Set(affected.map((x) => x.id))];
  ctx.addAffected(ids);

  const tasks = chunk(ids, 1000).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    const query = await pg.cancellableQuery(Prisma.sql`
      -- update image reaction metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount")
      SELECT
        ir."imageId",
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
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE ir."imageId" IN (${Prisma.join(ids)})
      GROUP BY ir."imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks({ pg, lastUpdate, jobContext, ...ctx }: ImageMetricContext) {
  const affectedQuery = await pg.cancellableQuery<{ id: number }>(Prisma.sql`
    -- get recent image comments
    SELECT t."imageId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."imageId" IS NOT NULL AND c."createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Image'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const ids = [...new Set(affected.map((x) => x.id))];
  ctx.addAffected(ids);

  const tasks = chunk(ids, 1000).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update image comment metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "commentCount")
      SELECT
        t."imageId",
        tf.timeframe,
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN 1
          WHEN tf.timeframe = 'Year' AND c."createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN tf.timeframe = 'Month' AND c."createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN tf.timeframe = 'Week' AND c."createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN tf.timeframe = 'Day' AND c."createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END)
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE t."imageId" IN (${Prisma.join(ids)})
      GROUP BY t."imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks({ pg, lastUpdate, jobContext, ...ctx }: ImageMetricContext) {
  const affectedQuery = await pg.cancellableQuery<{ id: number }>(Prisma.sql`
    -- get recent image collections
    SELECT "imageId" as id
    FROM "CollectionItem"
    WHERE "imageId" IS NOT NULL AND "createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Image'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const ids = [...new Set(affected.map((x) => x.id))];
  ctx.addAffected(ids);

  const tasks = chunk(ids, 1000).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update image collection metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "collectedCount")
      SELECT
        "imageId",
        tf.timeframe,
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN 1
          WHEN tf.timeframe = 'Year' AND "createdAt" > (NOW() - interval '365 days') THEN 1
          WHEN tf.timeframe = 'Month' AND "createdAt" > (NOW() - interval '30 days') THEN 1
          WHEN tf.timeframe = 'Week' AND "createdAt" > (NOW() - interval '7 days') THEN 1
          WHEN tf.timeframe = 'Day' AND "createdAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END)
      FROM "CollectionItem"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "imageId" IN (${Prisma.join(ids)})
      GROUP BY "imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "collectedCount" = EXCLUDED."collectedCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks({ pg, lastUpdate, jobContext, ...ctx }: ImageMetricContext) {
  const affectedQuery = await pg.cancellableQuery<{ id: number }>(Prisma.sql`
    -- get recent image tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Image' AND "createdAt" > ${lastUpdate}

    UNION

    SELECT
      "id"
    FROM "MetricUpdateQueue"
    WHERE type = 'Image'
  `);
  jobContext.on('cancel', affectedQuery.cancel);
  const affected = await affectedQuery.result();
  const ids = [...new Set(affected.map((x) => x.id))];
  ctx.addAffected(ids);

  const tasks = chunk(ids, 1000).map((ids, i) => async () => {
    jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    const query = await pg.cancellableQuery(Prisma.sql`
      -- update image tip metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "tippedCount", "tippedAmountCount")
      SELECT
        "entityId",
        tf.timeframe,
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN 1
          WHEN tf.timeframe = 'Year' AND "updatedAt" > (NOW() - interval '365 days') THEN 1
          WHEN tf.timeframe = 'Month' AND "updatedAt" > (NOW() - interval '30 days') THEN 1
          WHEN tf.timeframe = 'Week' AND "updatedAt" > (NOW() - interval '7 days') THEN 1
          WHEN tf.timeframe = 'Day' AND "updatedAt" > (NOW() - interval '1 days') THEN 1
          ELSE 0
        END) "tippedCount",
        SUM(CASE
          WHEN tf.timeframe = 'AllTime' THEN "amount"
          WHEN tf.timeframe = 'Year' AND "updatedAt" > (NOW() - interval '365 days') THEN "amount"
          WHEN tf.timeframe = 'Month' AND "updatedAt" > (NOW() - interval '30 days') THEN "amount"
          WHEN tf.timeframe = 'Week' AND "updatedAt" > (NOW() - interval '7 days') THEN "amount"
          WHEN tf.timeframe = 'Day' AND "updatedAt" > (NOW() - interval '1 days') THEN "amount"
          ELSE 0
        END) "tippedAmountCount"
      FROM "BuzzTip"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "entityId" IN (${Prisma.join(ids)}) AND "entityType" = 'Image'
      GROUP BY "entityId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "createdAt" = NOW()
    `);
    jobContext.on('cancel', query.cancel);
    await query.result();
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getViewTasks({ ch, pg, lastUpdate, jobContext, ...ctx }: ImageMetricContext) {
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const imageViews = await ch.query({
    query: `
        WITH targets AS (
          SELECT
            entityId
          FROM views
          WHERE entityType = 'Image'
          AND time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
        )
        SELECT
          entityId AS imageId,
          sumIf(views, createdDate = current_date()) day,
          sumIf(views, createdDate >= subtractDays(current_date(), 7)) week,
          sumIf(views, createdDate >= subtractDays(current_date(), 30)) month,
          sumIf(views, createdDate >= subtractYears(current_date(), 1)) year,
          sum(views) all_time
        FROM daily_views
        WHERE entityId IN (select entityId FROM targets)
          AND entityType = 'Image'
        GROUP BY imageId;
      `,
    format: 'JSONEachRow',
  });

  const viewedImages = (await imageViews?.json()) as [
    {
      imageId: number;
      day: number;
      week: number;
      month: number;
      year: number;
      all_time: number;
    }
  ];
  ctx.addAffected(viewedImages.map((x) => x.imageId));

  const tasks = chunk(viewedImages, 1000).map((batch, i) => async () => {
    jobContext.checkIfCanceled();
    log('getViewTasks', i + 1, 'of', tasks.length);
    try {
      const batchJson = JSON.stringify(batch);
      const updateChunkQuery = await pg.cancellableQuery(Prisma.sql`
        INSERT INTO "ImageMetric" ("imageId", timeframe, "viewCount")
        SELECT
          imageId,
          timeframe,
          views
        FROM
        (
            SELECT
                CAST(mvs::json->>'imageId' AS INT) AS imageId,
                tf.timeframe,
                CAST(
                  CASE
                    WHEN tf.timeframe = 'Day' THEN mvs::json->>'day'
                    WHEN tf.timeframe = 'Week' THEN mvs::json->>'week'
                    WHEN tf.timeframe = 'Month' THEN mvs::json->>'month'
                    WHEN tf.timeframe = 'Year' THEN mvs::json->>'year'
                    WHEN tf.timeframe = 'AllTime' THEN mvs::json->>'all_time'
                  END
                AS int) as views
            FROM json_array_elements(${batchJson}::json) mvs
            CROSS JOIN (
                SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
            ) tf
        ) im
        WHERE im.views IS NOT NULL
        AND im.imageId IN (SELECT id FROM "Image")
        ON CONFLICT ("imageId", timeframe) DO UPDATE
          SET "viewCount" = EXCLUDED."viewCount";
      `);
      jobContext.on('cancel', updateChunkQuery.cancel);
      await updateChunkQuery.result();
    } catch (err) {
      throw err;
    }
    log('getViewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
