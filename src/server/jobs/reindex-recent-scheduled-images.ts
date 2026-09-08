import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { commaDelimitedEnumArray } from '~/utils/zod-helpers';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

// Manual / one-off backfill. Re-syncs the image indexes for scheduled/rescheduled
// posts whose documents got frozen at the original scheduled time, or were never
// indexed at all — see https://app.clickup.com/t/868k68g0z (and the earlier
// modelVersion-only case https://app.clickup.com/t/868jc90r3).
//
// The two indexes are broken in different ways, which is why both are synced here:
//   - metrics_images_v1 takes every image and filters at query time, so a stale doc
//     carries the wrong sort position (GREATEST(publishedAt, scannedAt, createdAt)).
//   - images_v6 gates on `p."publishedAt" <= NOW()` at pull time, so a document
//     enqueued while the post was still future-dated was rejected outright and the
//     image is simply absent from site search.
//
// Targets posts still scheduled in the future (publishedAt > now) — the actively-broken
// "vanish entirely / surface at the wrong time" cases — plus posts published within the
// lookback window. Covers standalone posts too, not just ModelVersion-linked ones.
//
// Trigger via: /api/webhooks/run-jobs?run=reindex-recent-scheduled-images
//   &days=<lookback>   how far back to reach (default 3)
//   &limit=<n>         images per run (default 25000)
//   &afterId=<imageId> resume cursor; the run logs the last id it processed
//   &indexes=search,metrics   which indexes to sync (default both)

const DEFAULT_DAYS_LOOKBACK = 3;
const DEFAULT_LIMIT = 25000;

const schema = z.object({
  days: z.coerce.number().int().positive().default(DEFAULT_DAYS_LOOKBACK),
  limit: z.coerce.number().int().positive().max(100000).default(DEFAULT_LIMIT),
  afterId: z.coerce.number().int().nonnegative().default(0),
  indexes: commaDelimitedEnumArray(['search', 'metrics']).default(['search', 'metrics']),
});

export const reindexRecentScheduledImages = createJob(
  'reindex-recent-scheduled-images',
  UNRUNNABLE_JOB_CRON,
  async (jobContext) => {
    const { days, limit, afterId, indexes } = schema.parse(jobContext.req?.query ?? {});
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Future-scheduled posts are inherently at-risk. For already-published posts we only
    // reindex "scheduled-like" ones (publishedAt well after createdAt) to skip the large
    // volume of instant publishes that index fine.
    //
    // Ordered and cursored by image id so a backfill spanning more than one run resumes
    // where it stopped rather than re-walking the head of the range.
    const images = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" IS NOT NULL
        AND i.id > ${afterId}
        AND (
          p."publishedAt" > now()
          OR (
            p."publishedAt" >= ${since}
            AND p."publishedAt" > p."createdAt" + interval '15 minutes'
          )
        )
      ORDER BY i.id
      LIMIT ${limit}
    `;

    if (!images.length) {
      console.log('reindex-recent-scheduled-images :: no images to reindex');
      return { reindexed: 0, lastId: afterId, done: true };
    }

    const lastId = images[images.length - 1].id;
    console.log(
      `reindex-recent-scheduled-images :: reindexing ${
        images.length
      } images since ${since.toISOString()}`,
      { indexes, afterId, lastId }
    );

    const data = images.map(({ id }) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }));

    if (indexes.includes('metrics')) {
      await imagesMetricsSearchIndex.updateSync(data, jobContext);
    }
    if (indexes.includes('search')) {
      await imagesSearchIndex.updateSync(data, jobContext);
    }

    // `done` lets the operator stop without guessing: a short page is the last one.
    return { reindexed: images.length, lastId, done: images.length < limit };
  }
);
