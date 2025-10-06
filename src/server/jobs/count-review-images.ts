import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { createJob, getJobDate } from '~/server/jobs/job';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import type { Dayjs } from 'dayjs';

const log = createLogger('count-reviews', 'green');

export const countReviewImages = createJob('count-review-images', '0 22 * * *', async (ctx) => {
  return; // This job is disabled for now
  // Need to figure out a more efficient way to get this data... This was way too slow

  const [lastRun, setLastRun] = await getJobDate('count-review-images');

  // Get all image resources for images that were created since the last run
  console.log('Fetching affected reviews');
  const startDate = dayjs('2024-04-01').subtract(10, 'minutes');
  const endDate = dayjs().subtract(10, 'minutes');
  const days = splitIntoDays(startDate, endDate);

  const affectedReviews = new Set<number>();
  const getAffectedTasks = days.map((day, i) => async () => {
    ctx.checkIfCanceled();

    // Prep logging
    const logKey = `Processing day ${i + 1}/${days.length}`;
    console.log(logKey);
    console.time(logKey);

    const nextDay = day.add(1, 'day');
    const affectedReviewsQuery = await pgDbWrite.cancellableQuery<ReviewRow>(`
        SELECT DISTINCT
          rr.id as "reviewId"
        FROM "ImageResourceNew" ir
        JOIN "Image" i ON i.id = ir."imageId"
        JOIN "Post" p ON p.id = i."postId" AND p."publishedAt" IS NOT NULL
        JOIN "ResourceReview" rr ON rr."modelVersionId" = ir."modelVersionId" AND rr."userId" = i."userId"
        WHERE i."createdAt" BETWEEN
            '${day.toDate()}' AND '${nextDay.toDate()}'
          AND ir."modelVersionId" IS NOT NULL;
    `);
    ctx.on('cancel', affectedReviewsQuery.cancel);
    const dayAffectedReviews = (await affectedReviewsQuery.result()).map((r) => r.reviewId);
    console.timeEnd(logKey);

    dayAffectedReviews.forEach((r) => affectedReviews.add(r));
    console.log(`Affected reviews for ${day.format('YYYY-MM-DD')}:`, dayAffectedReviews.length);
  });
  await limitConcurrency(getAffectedTasks, 3);
  console.log('Affected reviews:', affectedReviews.size);

  // Count all images of those reviews
  const chunks = chunk([...affectedReviews], 100);
  const tasks = chunks.map((reviews, i) => async () => {
    ctx.checkIfCanceled();

    // Prep logging
    const logKey = `Processing chunk ${i + 1}/${chunks.length}`;
    console.log(logKey);
    console.time(logKey);

    // Get the count of images for each review
    const countsQuery = await pgDbWrite.cancellableQuery<ReviewImageCount>(`
      SELECT
        r.id as "reviewId",
        COUNT(i.id) AS images
      FROM "ResourceReview" r
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = r."modelVersionId"
      JOIN "Image" i ON i.id = ir."imageId" AND i."userId" = r."userId"
      WHERE r.id IN (${reviews})
      GROUP BY r.id;
    `);
    ctx.on('cancel', countsQuery.cancel);
    const counts = await countsQuery.result();

    if (counts.length > 0) {
      // Update the metadata on the reviews
      const values = counts.map((c) => `(${c.reviewId}, ${c.images})`);
      const updateQuery = await pgDbWrite.cancellableQuery(`
        UPDATE "ResourceReview" r SET
          "metadata" = COALESCE("metadata",'{}') || jsonb_build_object('imageCount', c.images)
        FROM (VALUES ${values}) AS c(id, images)
        WHERE r.id = c.id;
      `);
      await updateQuery.result();
    }

    console.timeEnd(logKey);
  });

  await limitConcurrency(tasks, 10);
  await setLastRun();
});

// Function to split date range into single-day intervals
const splitIntoDays = (startDate: Dayjs, endDate: Dayjs): Dayjs[] => {
  const days = [];
  let currentDay = startDate.startOf('day');
  while (currentDay.isBefore(endDate)) {
    days.push(currentDay);
    currentDay = currentDay.add(1, 'day');
  }
  return days;
};

type ReviewRow = {
  reviewId: number;
};
type ReviewImageCount = {
  reviewId: string;
  images: number;
};
