import { MeiliSearch } from 'meilisearch';
import { NextApiRequest, NextApiResponse } from 'next';
import { updateDocs } from '~/server/meilisearch/client';
import { limitConcurrency, sleep, Task } from '~/server/utils/concurrency-helpers';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const source = new MeiliSearch({
      host: '',
      apiKey: '',
    });
    const target = new MeiliSearch({
      host: '',
      apiKey: '',
    });

    const index = 'metrics_images_v1';

    let cursor = 0;
    const batchSize = 50000;
    const endCursor = cursor + batchSize;

    const tasks: Task[] = [];
    while (cursor < endCursor) {
      const start = cursor;
      let end = start + batchSize;
      if (end > endCursor) end = endCursor;
      tasks.push(async () => {
        const { hits } = await source.index(index).search('', {
          offset: 0,
          limit: batchSize + 1,
          filter: `id >= ${start} AND id < ${end}`,
          sort: ['id:asc'],
        });

        if (hits.length === 0) {
          return;
        }

        try {
          console.log('Updating documents :: ', hits.length, { start, end });

          await updateDocs({
            indexName: index,
            documents: hits,
            client: target,
          });

          await target.index(index).updateDocuments(hits);

          console.log('Updated documents :: ', { start, end });

          await sleep(1000);
        } catch (e) {
          console.error('Error updating documents :: ', e, { start, end });
        }
      });

      cursor = end;
    }

    await limitConcurrency(tasks, 5);

    return res.json({ success: true });
  } catch (e) {
    console.error('Error :: ', e);
    return res.status(500).json({ error: e });
  }
});
