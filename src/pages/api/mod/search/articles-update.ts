import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { ARTICLES_SEARCH_INDEX } from '../../../../server/common/constants';
import { updateDocs } from '../../../../server/meilisearch/client';
import { withRetries } from '../../../../server/utils/errorHandling';
import { userWithCosmeticsSelect } from '../../../../server/selectors/user.selector';

const BATCH_SIZE = 10000;
const INDEX_ID = ARTICLES_SEARCH_INDEX;
const WHERE = (idOffset: number) => ({
  id: { gt: idOffset },
  publishedAt: {
    not: null,
  },
  tosViolation: false,
});

const schema = z.object({
  update: z.enum(['user']),
});

const updateUser = (idOffset: number) =>
  withRetries(async () => {
    const records = await dbWrite.article.findMany({
      where: WHERE(idOffset),
      take: BATCH_SIZE,
      select: {
        id: true,
        user: {
          select: userWithCosmeticsSelect,
        },
      },
    });

    console.log(
      'Fetched records: ',
      records[0]?.id ?? 'N/A',
      ' - ',
      records[records.length - 1]?.id ?? 'N/A'
    );

    if (records.length === 0) {
      return -1;
    }

    const updateIndexReadyRecords = records;

    if (updateIndexReadyRecords.length === 0) {
      return -1;
    }

    await updateDocs({
      indexName: INDEX_ID,
      documents: updateIndexReadyRecords,
      batchSize: BATCH_SIZE,
    });

    console.log('Indexed records count: ', updateIndexReadyRecords.length);

    return updateIndexReadyRecords[updateIndexReadyRecords.length - 1].id;
  });

export default ModEndpoint(
  async function updateArticlesSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    const updateMethod: ((idOffset: number) => Promise<number>) | null =
      update === 'user' ? updateUser : null;

    try {
      if (!updateMethod) {
        return res.status(400).json({ ok: false, message: 'Invalid update method' });
      }

      let id = -1;
      while (true) {
        const updatedId = await updateMethod(id);

        if (updatedId === -1) {
          break;
        }

        id = updatedId;
      }

      return res.status(200).json({ ok: true, duration: Date.now() - start });
    } catch (error: unknown) {
      res.status(500).send(error);
    }
  },
  ['GET']
);
