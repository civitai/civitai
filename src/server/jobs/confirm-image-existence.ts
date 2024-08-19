import { Prisma } from '@prisma/client';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { createJob, getJobDate } from './job';

const jobName = 'check-image-existence';

export const checkImageExistence = createJob(jobName, '*/1 * * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate(jobName);

  try {
    // get list of ids of recently seen images from redis
    const recentlySeenIds: number[] = []; // TODO

    // find them in the db
    const existingImages = await dbWrite.$queryRaw<{ id: number; nsfwLevel: number }[]>`
      SELECT id, "nsfwLevel"
      FROM "Image"
      WHERE id in (${Prisma.join(recentlySeenIds)})
    `;
    const existingImagesIds = existingImages.map((i) => i.id);

    // delete ids that don't exist, or update ones that are blocked
    const deleteIds = recentlySeenIds.filter((id) => !existingImagesIds.includes(id));
    // TODO 0 as well?
    const updateIds = existingImages.filter((i) => i.nsfwLevel === NsfwLevel.Blocked);

    // TODO regular index too?
    // TODO delete immediately?

    if (deleteIds.length) {
      // await imagesMetricsSearchIndex.queueUpdate(
      //   deleteIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
      // );
      await onSearchIndexDocumentsCleanup({
        indexName: METRICS_IMAGES_SEARCH_INDEX,
        ids: deleteIds,
        client,
      });
    }
    if (updateIds.length) {
      // await imagesMetricsSearchIndex.queueUpdate(
      //   updateIds.map((i) => ({ id: i.id, action: SearchIndexUpdateQueueAction.Update }))
      // );
      await updateDocs({
        indexName: METRICS_IMAGES_SEARCH_INDEX,
        documents: existingImages,
        client,
      });
    }

    await setLastRun();
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'Failed to check image existence',
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
  }
});
