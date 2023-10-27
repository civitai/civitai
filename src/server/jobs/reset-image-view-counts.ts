import { chunk } from 'lodash';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

export const resetImageViewCounts = createJob(
  'reset-image-view-counts',
  UNRUNNABLE_JOB_CRON,
  async () => {
    if (!clickhouse) return;

    const imageViews = await clickhouse.query({
      query: `
        SELECT
          imageId,
          sumIf(views, createdDate = current_date()) day,
          sumIf(views, createdDate >= subtractDays(current_date(), 7)) week,
          sumIf(views, createdDate >= subtractDays(current_date(), 30)) month,
          sumIf(views, createdDate >= subtractYears(current_date(), 1)) year,
          sum(views) all_time
        FROM daily_image_views
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
    console.log(viewedImages.length);

    const batches = chunk(viewedImages, 1000);
    let i = 0;
    for (const batch of batches) {
      console.log(`Processing batch ${i + 1} of ${batches.length}`);
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
      i++;
    }
  }
);
