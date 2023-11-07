import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

const CONCURRENCY = 5;
export const resetImageViewCounts = createJob(
  'reset-image-view-counts',
  UNRUNNABLE_JOB_CRON,
  async () => {
    if (!clickhouse) return;

    const imageViews = await clickhouse.query({
      query: `
        SELECT
          entityId as imageId,
          sumIf(views, createdDate = current_date()) day,
          sumIf(views, createdDate >= subtractDays(current_date(), 7)) week,
          sumIf(views, createdDate >= subtractDays(current_date(), 30)) month,
          sumIf(views, createdDate >= subtractYears(current_date(), 1)) year,
          sum(views) all_time
        FROM daily_views
        WHERE entityType = 'Image'
        GROUP BY imageId;
      `,
      format: 'JSONEachRow',
    });
    const viewedImages = (await imageViews?.json()) as ImageViewCount[];
    console.log(viewedImages.length);

    const batches = chunk(viewedImages, 1000);
    console.log(`Processing ${batches.length} batches`);
    const tasks = batches.map((batch, i) => () => processBatch(batch, i));
    await limitConcurrency(tasks, CONCURRENCY);
  }
);

type ImageViewCount = {
  imageId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
async function processBatch(batch: ImageViewCount[], i: number) {
  console.log(`Processing batch ${i + 1}`);
  try {
    const batchJson = JSON.stringify(batch);
    await dbWrite.$executeRaw`
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
    `;
  } catch (e) {
    throw e;
  }
}
