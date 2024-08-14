import { Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { metricsClient, updateDocs } from '~/server/meilisearch/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';

const BATCH_SIZE = 10000;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;
const IMAGE_WHERE: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];

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
      await withRetries(async () => {
        type ImageForSearchIndex = {
          id: number;
          index: number;
          postId: number;
          url: string;
          nsfwLevel: number;
          prompt: string;
          sortAt: Date;
          type: string;
          width: number;
          height: number;
          userId: number;
          hasMeta: boolean;
          onSite: boolean;
          postedToId?: number;
          needsReview: string | null;
        };

        console.log('Fetching records from ID: ', start, end);
        const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
        SELECT
          i."id",
          i."index",
          i."postId",
          i."url",
          i."nsfwLevel",
          i."width",
          i."height",
          i."hash",
          i."meta"->'prompt' as "prompt",
          i."hideMeta",
          i."sortAt",
          i."type",
          i."userId",
          i."needsReview",
          (
            CASE
              WHEN i.meta IS NOT NULL AND NOT i."hideMeta"
              THEN TRUE
              ELSE FALSE
            END
          ) AS "hasMeta",
          (
            CASE
              WHEN i.meta->>'civitaiResources' IS NOT NULL
              THEN TRUE
              ELSE FALSE
            END
          ) as "onSite",
          p."modelVersionId" as "postedToId"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE i.id BETWEEN ${start} AND ${end} AND ${Prisma.join(IMAGE_WHERE, ' AND ')}; 
    `;

        console.log(
          'Fetched records: ',
          records[0]?.id ?? 'N/A',
          ' - ',
          records[records.length - 1]?.id ?? 'N/A'
        );

        if (records.length === 0) {
          return -1;
        }

        await updateDocs({
          indexName: INDEX_ID,
          documents: records.map((r) => ({
            ...r,
            sortAtUnix: r.sortAt.getTime(),
          })),
          batchSize: BATCH_SIZE,
          client: metricsClient,
        });

        console.log('Indexed records count: ', records.length);

        return records[records.length - 1].id;
      });
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
