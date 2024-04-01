import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesSearchIndex } from '~/server/search-index';
import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';

const log = createLogger('metrics:image');

export const imageMetrics = createMetricProcessor({
  name: 'Image',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      getViewTasks(ctx),
    ]);
    log('imageMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await imagesSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );

    // Update the age group of the metrics
    //---------------------------------------
    log('update age groups');
    await executeRefresh(ctx)`
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
    `;
  },
  async clearDay(ctx) {
    // Clear day of things updated in the last day
    await executeRefresh(ctx)`
      UPDATE "ImageMetric"
        SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
});

async function getReactionTasks(ctx: MetricProcessorRunContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affected = await getAffected(ctx)`
    -- get recent image reactions
    SELECT
      "imageId" AS id
    FROM "ImageReaction"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    await executeRefresh(ctx)`
      -- update image reaction metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, ${snippets.reactionMetricNames})
      SELECT
        r."imageId",
        tf.timeframe,
        ${snippets.reactionTimeframes()}
      FROM "ImageReaction" r
      JOIN "Image" i ON i.id = r."imageId" -- ensure the image exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE r."imageId" IN (${ids})
      GROUP BY r."imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET ${snippets.reactionMetricUpserts}, "updatedAt" = NOW()
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent image comments
    SELECT t."imageId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."imageId" IS NOT NULL AND c."createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update image comment metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "commentCount")
      SELECT
        t."imageId",
        tf.timeframe,
        ${snippets.timeframeSum('c."createdAt"')}
      FROM "Thread" t
      JOIN "Image" i ON i.id = t."imageId" -- ensure the image exists
      JOIN "CommentV2" c ON c."threadId" = t.id
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE t."imageId" IN (${ids})
      GROUP BY t."imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = NOW()
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent image collections
    SELECT "imageId" as id
    FROM "CollectionItem"
    WHERE "imageId" IS NOT NULL AND "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update image collection metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "collectedCount")
      SELECT
        "imageId",
        tf.timeframe,
        ${snippets.timeframeSum('ci."createdAt"')}
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId" -- ensure the image exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE ci."imageId" IN (${ids})
      GROUP BY ci."imageId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = NOW()
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent image tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Image' AND ("createdAt" > '${ctx.lastUpdate}' OR "updatedAt" > '${ctx.lastUpdate}')
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update image tip metrics
      INSERT INTO "ImageMetric" ("imageId", timeframe, "tippedCount", "tippedAmountCount")
      SELECT
        "entityId",
        tf.timeframe,
        ${snippets.timeframeSum('bt."updatedAt"')} "tippedCount",
        ${snippets.timeframeSum('bt."updatedAt"', 'amount')} "tippedAmountCount"
      FROM "BuzzTip" bt
      JOIN "Image" i ON i.id = bt."entityId" -- ensure the image exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "entityId" IN (${ids}) AND "entityType" = 'Image'
      GROUP BY "entityId", tf.timeframe
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = NOW()
    `;
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type ImageMetricView = {
  imageId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
async function getViewTasks(ctx: MetricProcessorRunContext) {
  const clickhouseSince = dayjs(ctx.lastUpdate).toISOString();
  const viewed = await ctx.ch.$query<ImageMetricView>`
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
  `;
  ctx.addAffected(viewed.map((x) => x.imageId));

  const tasks = chunk(viewed, 1000).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getViewTasks', i + 1, 'of', tasks.length);
    try {
      const batchJson = JSON.stringify(batch);
      await executeRefresh(ctx)`
        -- update image view metrics
        INSERT INTO "ImageMetric" ("imageId", timeframe, "viewCount")
        SELECT
          "imageId",
          timeframe,
          views
        FROM (
            SELECT
                CAST(mvs::json->>'imageId' AS INT) AS "imageId",
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
            FROM json_array_elements('${batchJson}'::json) mvs
            CROSS JOIN (
                SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
            ) tf
        ) im
        JOIN "Image" i ON i.id = im."imageId" -- ensure the image exists
        WHERE im.views IS NOT NULL
        AND im."imageId" IN (SELECT id FROM "Image")
        ON CONFLICT ("imageId", timeframe) DO UPDATE
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
