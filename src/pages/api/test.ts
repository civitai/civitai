// import { chunk } from 'lodash-es';
// import { NextApiRequest, NextApiResponse } from 'next';
// import { IMAGES_SEARCH_INDEX, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
// import { dbWrite } from '~/server/db/client';
// import { metricsSearchClient, searchClient, updateDocs } from '~/server/meilisearch/client';
// import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
// import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
// import ids from './test.json';

// export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
//   try {
//     // Now batch the update task:
//     console.log('Updating POI images:', ids.length);
//     // return res.status(200).json({
//     //   status: 'ok',
//     //   ids: [...new Set(ids)],
//     // });

//     const batches = chunk(ids, 10000);
//     const updateTasks: Task[] = [];
//     for (const batch of batches) {
//       updateTasks.push(async () => {
//         console.log('Updating POI images:', batch.length);
//         console.log('search index', IMAGES_SEARCH_INDEX);
//         await updateDocs({
//           documents: batch.map((id) => ({
//             id,
//             poi: true,
//           })),
//           indexName: IMAGES_SEARCH_INDEX,
//           client: searchClient,
//           batchSize: 10000,
//         });

//         console.log('metrics index', METRICS_IMAGES_SEARCH_INDEX);
//         await updateDocs({
//           documents: batch.map((id) => ({
//             id,
//             poi: true,
//           })),
//           indexName: METRICS_IMAGES_SEARCH_INDEX,
//           client: metricsSearchClient,
//           batchSize: 10000,
//         });

//         console.log('SQL');
//         await dbWrite.image.updateMany({
//           where: {
//             id: { in: batch },
//           },
//           data: {
//             poi: true,
//           },
//         });
//         console.log('Done');
//       });
//     }

//     await limitConcurrency(updateTasks, 1);

//     return res.status(200).json({
//       status: 'ok',
//       ids: [...new Set(ids)],
//     });
//   } catch (e) {
//     console.error('Error :: ', e);
//     res.status(500).json({
//       message: 'Error',
//       e,
//     });
//   }
// });
