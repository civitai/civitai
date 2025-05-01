// import { NextApiRequest, NextApiResponse } from 'next';
// import { IMAGES_SEARCH_INDEX, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
// import { dbRead } from '~/server/db/client';
// import { metricsSearchClient, searchClient, updateDocs } from '~/server/meilisearch/client';
// import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
// import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
// import { checkable, includesPoi } from '~/utils/metadata/audit';
// import poiWords from '~/utils/metadata/lists/words-poi.json';

// export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
//   try {
//     const tasks: Task[] = [];
//     const poiImageIds: number[] = [];

//     for (let i = 0; i < poiWords.length; i++) {
//       tasks.push(async () => {
//         console.log('Running task', i, 'of', poiWords.length);
//         const word = poiWords[i];
//         const check = checkable([word], {
//           preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
//         });

//         try {
//           console.log('Searching for word:', word);
//           const search = await searchClient?.index(IMAGES_SEARCH_INDEX).search(word, {
//             limit: 20000,
//             // We already know poi are images are poi.
//             filter: 'poi != true',
//             attributesToRetrieve: ['id', 'prompt'],
//           });

//           const { hits } = search;

//           console.log('Found hits:', hits.length);

//           const poiHits = hits.filter((hit) => {
//             return hit.prompt && check.inPrompt(hit.prompt.toLowerCase());
//           });

//           if (poiHits.length) {
//             console.log('Found POI hits for word:', word, poiHits.length);
//             poiImageIds.push(...poiHits.map((hit) => hit.id));
//             // await updateDocs({
//             //   documents: poiHits.map((hit) => ({
//             //     id: hit.id,
//             //     minor: true,
//             //   })),
//             //   indexName: IMAGES_SEARCH_INDEX,
//             //   client: searchClient,
//             //   batchSize: 10000,
//             // });
//           } else {
//             console.log('No POI hits for word:', word);
//           }
//         } catch (e) {
//           console.error('Error searching for word:', word, e);
//         }
//       });
//     }

//     await limitConcurrency(tasks, 1);

//     return res.status(200).json({
//       status: 'ok',
//       ids: [...new Set(poiImageIds)],
//     });
//   } catch (e) {
//     console.error('Error :: ', e);
//     res.status(500).json({
//       message: 'Error',
//       e,
//     });
//   }
// });
