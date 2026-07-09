import { dbRead } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

// Manual / one-off backfill. Re-syncs the metrics_images_v1 index for images
// of scheduled/rescheduled posts whose feed sort position got frozen at the
// original scheduled time (or never indexed at all) because the reschedule
// never propagated to the index — see https://app.clickup.com/t/868k68g0z
// (and the earlier modelVersion-only case https://app.clickup.com/t/868jc90r3).
//
// Targets posts still scheduled in the future (publishedAt > now) — the
// actively-broken "vanish entirely / surface at the wrong time" cases — plus
// posts published within a short recent window. Covers standalone posts too,
// not just ModelVersion-linked ones.
//
// Trigger via: /api/webhooks/run-jobs?run=reindex-recent-scheduled-images

const DAYS_LOOKBACK = 3;

export const reindexRecentScheduledImages = createJob(
  'reindex-recent-scheduled-images',
  UNRUNNABLE_JOB_CRON,
  async (jobContext) => {
    const since = new Date(Date.now() - DAYS_LOOKBACK * 24 * 60 * 60 * 1000);

    // Future-scheduled posts are inherently at-risk. For recently-published
    // posts we only reindex "scheduled-like" ones (publishedAt well after
    // createdAt) to skip the large volume of instant publishes that index fine.
    const images = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" IS NOT NULL
        AND (
          p."publishedAt" > now()
          OR (
            p."publishedAt" >= ${since}
            AND p."publishedAt" > p."createdAt" + interval '15 minutes'
          )
        )
    `;

    if (!images.length) {
      console.log('reindex-recent-scheduled-images :: no images to reindex');
      return;
    }

    console.log(
      `reindex-recent-scheduled-images :: reindexing ${
        images.length
      } images since ${since.toISOString()}`
    );

    const data = images.map(({ id }) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }));

    await imagesMetricsSearchIndex.updateSync(data, jobContext);
  }
);
