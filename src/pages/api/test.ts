import { metadata } from 'motion/dist/react-m';
import { NextApiRequest, NextApiResponse } from 'next';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { BlockedReason, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { metricsSearchClient, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { sleep, withRetries } from '~/utils/errorHandling';
import { isValidAIGeneration } from '~/utils/image-utils';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // try {
  //   const baseCursor = 0;
  //   const source = metricsSearchClient;
  //   const indexes = [METRICS_IMAGES_SEARCH_INDEX];
  //   const highestIds: Record<string, number> = {};
  //   const affectedUsers: number[] = [];
  //   const imageIds: number[] = [];
  //   let total = 0;
  //   console.log('Indexes to migrate :: ', indexes);
  //   const jobs = indexes.map((index, i) => async () => {
  //     try {
  //       const sourceIndex = await getOrCreateIndex(index, { primaryKey: 'id' }, source);
  //       if (!sourceIndex) {
  //         throw new Error('Could not create source index');
  //       }
  //       // Clone settings:
  //       const settings = await sourceIndex.getSettings();
  //       // Now, we can go ahead and start adding stuff:
  //       let cursor = Array.isArray(baseCursor) ? baseCursor[i] : baseCursor;
  //       const batchSize = Math.min(settings.pagination?.maxTotalHits ?? 1000000, 100000);
  //       let endCursor = cursor + batchSize;
  //       const { hits } = await sourceIndex.search('', {
  //         offset: 0,
  //         limit: 1,
  //         sort: ['id:desc'],
  //       });
  //       if (hits.length === 0) {
  //         return;
  //       }
  //       // Play it safe:
  //       endCursor = Math.max(hits[0].id + 1, endCursor);
  //       console.log('Highest ID registered :: ', endCursor, ' Starting from:', cursor);
  //       highestIds[index] = endCursor;
  //       const tasks: Task[] = [];
  //       while (cursor < endCursor) {
  //         const start = cursor;
  //         let end = start + batchSize;
  //         if (end > endCursor) end = endCursor + 1;
  //         tasks.push(async () => {
  //           try {
  //             return withRetries(
  //               async (remainingAttempts) => {
  //                 try {
  //                   console.log('Getting documents :: ', { start, end });
  //                   const { hits } = await sourceIndex.search('', {
  //                     offset: 0,
  //                     limit: batchSize + 1,
  //                     filter: `
  //                       id >= ${start} AND id < ${end}
  //                       AND (hasMeta = false OR hasMeta IS NULL OR hasMeta IS EMPTY)
  //                       AND nsfwLevel > 4
  //                       `,
  //                     sort: ['id:asc'],
  //                   });
  //                   if (hits.length === 0) {
  //                     return;
  //                   }
  //                   total += hits.length;
  //                   const data = await dbWrite.image.findMany({
  //                     where: {
  //                       id: {
  //                         in: hits.map((hit) => hit.id),
  //                       },
  //                     },
  //                     select: {
  //                       id: true,
  //                       meta: true,
  //                       metadata: true,
  //                       nsfwLevel: true,
  //                     },
  //                   });
  //                   const invalidImages = data.filter((image) => {
  //                     return !isValidAIGeneration({
  //                       ...image,
  //                       meta: image.meta as ImageMetaProps,
  //                     });
  //                   });
  //                   affectedUsers.push(...hits.map((hit) => hit.userId));
  //                   imageIds.push(...invalidImages.map((hit) => hit.id));
  //                   await dbWrite.image.updateMany({
  //                     where: {
  //                       id: {
  //                         in: invalidImages.map((image) => image.id),
  //                       },
  //                     },
  //                     data: {
  //                       blockedFor: BlockedReason.AiNotVerified,
  //                       ingestion: ImageIngestionStatus.Blocked,
  //                     },
  //                   });
  //                   await updateDocs({
  //                     documents: hits.map((hit) => ({
  //                       id: hit.id,
  //                       blockedFor: BlockedReason.AiNotVerified,
  //                     })),
  //                     indexName: index,
  //                     client: metricsSearchClient,
  //                     batchSize: 10000,
  //                   });
  //                   // Ensure we try to avoid rate limiting.
  //                   await sleep(500 + (5 - remainingAttempts) * 1000);
  //                 } catch (e) {
  //                   console.error('Error updating documents :: ', e, {
  //                     start,
  //                     end,
  //                     remainingAttempts,
  //                   });
  //                   throw e;
  //                 }
  //               },
  //               5,
  //               5000
  //             );
  //           } catch (e) {
  //             // No-op. Batch just failde.
  //             console.error('Error updating batch :: ', e);
  //           }
  //         });
  //         cursor = end;
  //       }
  //       console.log('Total number of tasks: ', tasks.length);
  //       await limitConcurrency(tasks, 5);
  //       console.log('Index migration completed :: ', index, 'total:', total);
  //     } catch (e) {
  //       console.error('Error migrating index :: ', index, e);
  //     }
  //   });
  //   // Migrate 1 by 1.
  //   // http://localhost:3000/api/test
  //   await limitConcurrency(jobs, 1);
  //   return res.status(200).json({
  //     message: 'Migration completed',
  //     highestIds,
  //     indexes,
  //     total,
  //     affectedUsers: [...new Set(affectedUsers)],
  //     invalidImages: [...new Set(imageIds)],
  //   });
  // } catch (e) {
  //   console.error('Error :: ', e);
  //   res.status(500).json({
  //     message: 'Error',
  //     e,
  //   });
  // }
});
