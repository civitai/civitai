import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createJob, getJobDate } from './job';
import { imagesMetricsSearchIndex } from '~/server/search-index';

const jobName = 'check-image-existence';
const queryBatch = 2000;
const popLimit = queryBatch * 5;

export const checkImageExistence = createJob(jobName, '*/1 * * * *', async () => {
  const [, setLastRun] = await getJobDate(jobName);

  try {
    // get list of ids of recently seen images from redis
    const recentlySeenIds = await sysRedis.packed.sPop<number>(
      REDIS_SYS_KEYS.QUEUES.SEEN_IMAGES,
      popLimit
    );
    if (recentlySeenIds && recentlySeenIds.length) {
      const batches = chunk(recentlySeenIds, queryBatch);
      for (const batch of batches) {
        if (!batch.length) continue;

        // find them in the db
        const existingImages = await dbWrite.$queryRaw<{ id: number; nsfwLevel: number }[]>`
          SELECT id, "nsfwLevel"
          FROM "Image"
          WHERE id in (${Prisma.join(batch)})
        `;
        const existingImagesIds = existingImages.map((i) => i.id);

        // delete ids that don't exist, or update ones that are blocked
        const deleteIds = batch.filter((id) => !existingImagesIds.includes(id));
        const updateData = existingImages.filter((i) =>
          [NsfwLevel.Blocked, 0].includes(i.nsfwLevel)
        );

        // TODO regular index too
        if (deleteIds.length) {
          await imagesMetricsSearchIndex.queueUpdate(
            deleteIds.map((id) => ({
              id,
              action: SearchIndexUpdateQueueAction.Delete,
            }))
          );
        }

        if (updateData.length) {
          await imagesMetricsSearchIndex.queueUpdate(
            updateData.map((i) => ({
              id: i.id,
              action: SearchIndexUpdateQueueAction.Update,
            }))
          );
        }
      }
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
