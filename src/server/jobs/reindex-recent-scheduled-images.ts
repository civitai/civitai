import { dbRead } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

// Manual / one-off job. Re-syncs the metrics_images_v1 index for images whose
// parent post was (scheduled-)published recently. Some images weren't picked
// up by the normal indexing path after scheduled publishing — see task
// https://app.clickup.com/t/868jc90r3.
//
// Trigger via: /api/webhooks/run-jobs?run=reindex-recent-scheduled-images

const DAYS_LOOKBACK = 3;

export const reindexRecentScheduledImages = createJob(
  'reindex-recent-scheduled-images',
  UNRUNNABLE_JOB_CRON,
  async (jobContext) => {
    const since = new Date(Date.now() - DAYS_LOOKBACK * 24 * 60 * 60 * 1000);

    // Images belonging to posts that were published in the lookback window
    // through a ModelVersion (the scheduled-publishing flow only applies to
    // posts linked to a ModelVersion).
    const images = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" >= ${since}
        AND p."publishedAt" IS NOT NULL
        AND p."modelVersionId" IS NOT NULL
    `;

    if (!images.length) {
      console.log('reindex-recent-scheduled-images :: no images to reindex');
      return;
    }

    console.log(
      `reindex-recent-scheduled-images :: reindexing ${images.length} images since ${since.toISOString()}`
    );

    const data = images.map(({ id }) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }));

    await imagesMetricsSearchIndex.updateSync(data, jobContext);
  }
);
