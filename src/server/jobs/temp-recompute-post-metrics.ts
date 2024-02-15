import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const tempRecomputePostMetrics = createJob(
  'recompute-post-metrics',
  '13 1 * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('recompute-post-metrics');

    await dbWrite.$executeRaw`
    -- upsert metrics for all posts
    INSERT INTO "PostMetric" ("postId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount")
    SELECT
      i."postId",
      im.timeframe,
      SUM(im."likeCount") as "likeCount",
      SUM(im."dislikeCount") as "dislikeCount",
      SUM(im."heartCount") as "heartCount",
      SUM(im."laughCount") as "laughCount",
      SUM(im."cryCount") as "cryCount"
    FROM "ImageMetric" im
    JOIN "Image" i ON i.id = im."imageId"
    WHERE i."postId" IS NOT NULL
    GROUP BY i."postId", im.timeframe
    ON CONFLICT ("postId", timeframe) DO UPDATE
      SET "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount";
  `;

    await setLastRun();
  }
);
