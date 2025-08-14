import { chunk } from 'lodash-es';
import type { SearchResponse } from 'meilisearch';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { IMAGES_SEARCH_INDEX, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { metricsSearchClient, searchClient, updateDocs } from '~/server/meilisearch/client';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { checkable, includesPoi } from '~/utils/metadata/audit';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const schema = z.object({
  words: commaDelimitedStringArray(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const result = schema.safeParse(req.query);
    if (!result.success) return res.status(400).json({ error: result.error });
    const { words } = result.data;

    const tasks: Task[] = [];
    const poiImageIds: number[] = [];

    for (let i = 0; i < words.length; i++) {
      tasks.push(async () => {
        console.log('Running task', i, 'of', words.length);
        const word = words[i];
        const check = checkable([word], {
          preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
        });

        try {
          console.log('Searching for word:', word);
          const search: SearchResponse<{ id: number; prompt: string }> = await searchClient!
            .index(IMAGES_SEARCH_INDEX)
            .search(word, {
              limit: 20000,
              // We already know poi are images are poi.
              filter: 'poi != true',
              attributesToRetrieve: ['id', 'prompt'],
            });

          const { hits } = search;

          console.log('Found hits:', hits.length);

          const poiHits = hits.filter((hit) => {
            return hit.prompt && check.inPrompt(hit.prompt.toLowerCase());
          });

          if (poiHits.length) {
            console.log('Found POI hits for word:', word, poiHits.length);
            poiImageIds.push(...poiHits.map((hit) => hit.id));
            // await updateDocs({
            //   documents: poiHits.map((hit) => ({
            //     id: hit.id,
            //     minor: true,
            //   })),
            //   indexName: IMAGES_SEARCH_INDEX,
            //   client: searchClient,
            //   batchSize: 10000,
            // });
          } else {
            console.log('No POI hits for word:', word);
          }
        } catch (e) {
          console.error('Error searching for word:', word, e);
        }
      });
    }

    await limitConcurrency(tasks, 1);

    // Now batch the update task:
    const batches = chunk(poiImageIds, 10000);
    const updateTasks: Task[] = [];
    for (const batch of batches) {
      updateTasks.push(async () => {
        await updateDocs({
          documents: batch.map((id) => ({
            id,
            poi: true,
          })),
          indexName: IMAGES_SEARCH_INDEX,
          client: searchClient,
          batchSize: 10000,
        });

        await updateDocs({
          documents: batch.map((id) => ({
            id,
            poi: true,
          })),
          indexName: METRICS_IMAGES_SEARCH_INDEX,
          client: metricsSearchClient,
          batchSize: 10000,
        });

        await dbWrite.image.updateMany({
          where: {
            id: { in: batch },
          },
          data: {
            poi: true,
          },
        });
      });
    }

    await limitConcurrency(updateTasks, 1);

    return res.status(200).json({
      status: 'ok',
      ids: [...new Set(poiImageIds)],
    });
  } catch (e) {
    console.error('Error :: ', e);
    res.status(500).json({
      message: 'Error',
      e,
    });
  }
});
