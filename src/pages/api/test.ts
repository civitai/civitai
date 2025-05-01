import { NextApiRequest, NextApiResponse } from 'next';
import { IMAGES_SEARCH_INDEX, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { metricsSearchClient, searchClient, updateDocs } from '~/server/meilisearch/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // try {
  //   const [{ min }] = await dbRead.$queryRaw<{ min: number; max: number }[]>`
  //     SELECT MIN("id") as min, MAX("id") as max
  //     FROM tmp_minor_images
  //   `;
  //   let cursor = min - 1;
  //   const batchSize = 100000;
  //   // if (true) {
  //   //   return res.status(200).json({
  //   //     message: 'Migration completed',
  //   //     min,
  //   //   });
  //   // }
  //   while (true) {
  //     console.log('Getting documents :: ', { cursor });
  //     const values = await dbRead.$queryRaw<{ id: number }[]>`
  //         SELECT "id"
  //         FROM tmp_minor_images
  //         WHERE "id" > ${cursor}
  //         ORDER BY "id" ASC
  //         LIMIT ${batchSize}
  //       `;
  //     if (!values.length) {
  //       console.log('No more documents to process');
  //       break;
  //     }
  //     await updateDocs({
  //       documents: values.map((hit) => ({
  //         id: hit.id,
  //         minor: true,
  //       })),
  //       indexName: IMAGES_SEARCH_INDEX,
  //       client: searchClient,
  //       batchSize: 10000,
  //     });
  //     // Ensure we try to avoid rate limiting.
  //     cursor = values[values.length - 1].id;
  //   }
  //   return res.status(200).json({
  //     status: 'ok',
  //   });
  // } catch (e) {
  //   console.error('Error :: ', e);
  //   res.status(500).json({
  //     message: 'Error',
  //     e,
  //   });
  // }
});
