// import Decimal from 'decimal.js';
// import { NextApiRequest, NextApiResponse } from 'next';
// import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
// import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
// import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
// import { searchClient } from '~/server/meilisearch/client';
// import { modelsSearchIndex } from '~/server/search-index';
// import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
// import { sleep } from '~/utils/errorHandling';

// export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
//   const index = await searchClient?.index(MODELS_SEARCH_INDEX);

//   if (!index) {
//     res.status(500).json({ error: 'Search index not available' });
//     return;
//   }

//   const limit = 100000;
//   const filter = ['canGenerate = true'];

//   let cursor = 0;
//   let endCursor = cursor + limit;

//   const { hits } = await index.search('', {
//     offset: 0,
//     limit: 1,
//     sort: ['id:desc'],
//     filter,
//   });

//   if (hits.length === 0) {
//     return;
//   }

//   // Play it safe:
//   endCursor = Math.max(hits[0].id + 1, endCursor);

//   const ids = [];

//   while (cursor < endCursor) {
//     const end = cursor + limit;
//     const { hits: canGenerateItems } = await index?.search('', {
//       limit,
//       attributesToRetrieve: ['id', 'canGenerate'],
//       sort: ['id:asc'],
//       filter: [...filter, `id >= ${cursor} AND id < ${end}`],
//     });

//     ids.push(...canGenerateItems.map((item) => item.id));
//     console.log('Fetched IDs :: ', canGenerateItems.length, { cursor, end });
//     modelsSearchIndex.queueUpdate(
//       canGenerateItems.map((item) => ({
//         id: item.id,
//         action: SearchIndexUpdateQueueAction.Update,
//       }))
//     );

//     cursor = end;
//     await sleep(1000); // Sleep to avoid rate limiting
//   }

//   res.status(200).json({
//     quantity: ids.length,
//   });
// });
