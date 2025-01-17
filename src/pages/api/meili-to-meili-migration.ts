import { MeiliSearch } from 'meilisearch';
import { NextApiRequest, NextApiResponse } from 'next';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { sleep } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const source = new MeiliSearch({
      host: '/',
      apiKey: '',
    });
    const target = new MeiliSearch({
      host: '/',
      apiKey: '',
    });

    const index = 'metrics_images_v1';

    let from = 1735731876028;

    while (true) {
      const { hits } = await source.index(index).search('', {
        offset: 0,
        limit: 50000,
        filter: `sortAtUnix > ${from}`,
        sort: ['sortAt:asc'],
      });

      if (hits.length === 0) {
        break;
      }

      const documents = hits.map((hit) => {
        // lastId = Math.max(lastId, hit.id);
        from = Math.max(from, hit.sortAtUnix);
        return hit;
      });

      console.log('Updating documents :: ', documents.length, from);

      await target.index(index).updateDocuments(documents);

      await sleep(1000);
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error :: ', e);
    return res.status(500).json({ error: e });
  }
});
