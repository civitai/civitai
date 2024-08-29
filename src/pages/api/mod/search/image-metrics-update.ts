import { Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { metricsSearchClient, updateDocs } from '~/server/meilisearch/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const BATCH_SIZE = 100000;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

// TODO sync this with the search-index code

const schema = z.object({
  update: z.enum(['addFields']),
});
const addFields = async () => {
  await dataProcessor({
    params: { batchSize: BATCH_SIZE, concurrency: 10, start: 0 },
    runContext: {
      on: (event: 'close', listener: () => void) => {
        // noop
      },
    },
    rangeFetcher: async (ctx) => {
      const [{ start, end }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
        WITH dates AS (
          SELECT
          MIN("createdAt") as start,
          MAX("createdAt") as end
          FROM "Image"
        )
        SELECT MIN(id) as start, MAX(id) as end
        FROM "Image" i
        JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
      `;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      type ImageForSearchIndex = {
        id: number;
        publishedAt?: Date;
        sortAt: Date;
        nsfwLevel: NsfwLevel;
        aiNsfwLevel: NsfwLevel;
        nsfwLevelLocked: boolean;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
        SELECT
          i."id",
          p."publishedAt",
          COALESCE(p."publishedAt", i."createdAt") as "sortAt",
          i."nsfwLevel",
          i."aiNsfwLevel",
          i."nsfwLevelLocked"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId"
        WHERE i.id BETWEEN ${start} AND ${end}
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) {
        console.log(`No updates found:  ${start} - ${end}`);
        return;
      }

      const consoleTransformKey = `Transform: ${start} - ${end}`;
      console.log(consoleTransformKey);
      console.time(consoleTransformKey);
      const documents = records.map(({ publishedAt, nsfwLevelLocked, ...r }) => ({
        ...r,
        combinedNsfwLevel: nsfwLevelLocked ? r.nsfwLevel : Math.max(r.nsfwLevel, r.aiNsfwLevel),
        publishedAtUnix: publishedAt?.getTime(),
        sortAtUnix: r.sortAt.getTime(),
      }));
      console.timeEnd(consoleTransformKey);

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents,
        batchSize: BATCH_SIZE,
        client: metricsSearchClient,
      });
      console.timeEnd(consolePushKey);
    },
  });
};

export default ModEndpoint(
  async function updateImageSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    const updateMethod: (() => Promise<any>) | null = update === 'addFields' ? addFields : null;

    try {
      if (!updateMethod) {
        return res.status(400).json({ ok: false, message: 'Invalid update method' });
      }

      await updateMethod();

      return res.status(200).json({ ok: true, duration: Date.now() - start });
    } catch (error: unknown) {
      res.status(500).send(error);
    }
  },
  ['GET']
);
