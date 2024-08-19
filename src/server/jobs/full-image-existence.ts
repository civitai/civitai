import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { makeMeiliImageSearchFilter } from '~/server/services/image.service';
import { createJob, getJobDate } from './job';

const jobName = 'full-image-existence';
const queryBatch = 1e6;

export const fullImageExistence = createJob(jobName, '40 6 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate(jobName);

  try {
    // find bounds for images in the db
    const bounds = await dbWrite.$queryRaw<{ minId: number; maxId: number }[]>`
        SELECT MIN(id) as "minId", MAX(id) as "maxId"
        FROM "Image"
        WHERE "postId" IS NOT NULL
    `;
    const { minId, maxId } = bounds[0];

    const firstTime = new Date().getTime();

    // in batches...
    let start = minId;
    while (start <= maxId) {
      const end = start + queryBatch;

      const existedAtUnix = new Date().getTime();

      // find images in db
      const existingImages = await dbWrite.$queryRaw<
        { id: number; nsfwLevel: number; existedAtUnix: number }[]
      >`
        SELECT id, "nsfwLevel", ${existedAtUnix} as "existedAtUnix"
        FROM "Image"
        WHERE id BETWEEN ${start} AND ${end}
      `;

      if (existingImages.length) {
        // TODO if the images aren't there yet...
        await updateDocs({
          indexName: METRICS_IMAGES_SEARCH_INDEX,
          documents: existingImages,
          // batchSize: queryBatch,
          client,
        });
      }

      start = end + 1;
    }

    const index = await getOrCreateIndex(METRICS_IMAGES_SEARCH_INDEX, undefined, client);
    if (index) {
      await index.deleteDocuments({
        filter: makeMeiliImageSearchFilter('existedAtUnix', `< ${firstTime}`),
      });
    }

    // TODO if the above doesnt work...
    // if (metricsSearchClient) {
    //   const filters: string[] = [];
    //   filters.push(makeMeiliImageSearchFilter('existedAtUnix', `< ${firstTime}`));
    //
    //   let more = true;
    //   let offset = 0;
    //   while (more) {
    //     const request: DocumentsQuery = {
    //       filter: filters.join(' AND '),
    //       limit: 1000,
    //       offset,
    //     };
    //
    //     const results: SearchResponse<ImageMetricsSearchIndexRecord> = await metricsSearchClient
    //       .index(METRICS_IMAGES_SEARCH_INDEX)
    //       .search(null, request);
    //   }
    // }

    // TODO set in redis or is this good enough?

    await setLastRun();
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'Failed to check full image existence',
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
  }
});
