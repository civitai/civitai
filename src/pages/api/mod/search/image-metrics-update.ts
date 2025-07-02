import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbReadLong } from '~/server/db/pgDb';
import { metricsSearchClient, updateDocs } from '~/server/meilisearch/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma } from '@prisma/client';

const BATCH_SIZE = 100000;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

// TODO sync this with the search-index code

const schema = z.object({
  update: z.enum(['addFields', 'baseModel', 'addCollections']),
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
          GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
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

const updateBaseModel = async () => {
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
        modelVersionIds: number[];
        baseModel?: string;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
          SELECT
            ir."imageId" as id,
            string_agg(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '') as "baseModel",
            array_agg(mv."id") as "modelVersionIds",
            SUM(IIF(m.poi, 1, 0)) > 0 "poi"
          FROM "ImageResourceNew" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
          JOIN "Model" m ON mv."modelId" = m."id"
          WHERE ir."imageId" BETWEEN ${start} AND ${end}
          GROUP BY ir."imageId"
        `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) return;

      const consoleTransformKey = `Transform: ${start} - ${end}`;
      console.log(consoleTransformKey);
      console.time(consoleTransformKey);
      console.timeEnd(consoleTransformKey);

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents: records,
        batchSize: BATCH_SIZE,
        client: metricsSearchClient,
      });
      console.timeEnd(consolePushKey);
    },
  });
};

const addCollections = async () => {
  const fetchKey = 'Fetch';
  console.log(fetchKey);
  console.time(fetchKey);
  const query = await pgDbReadLong.cancellableQuery<{ id: number; collections: number[] }>(`
    SELECT
      "imageId" as id,
      array_agg("collectionId") as "collections"
    FROM "CollectionItem"
    WHERE "imageId" IS NOT NULL
    GROUP BY 1;
  `);
  const results = await query.result();
  console.timeEnd(fetchKey);

  const chunks = chunk(results, BATCH_SIZE);
  const tasks = chunks.map((batch, i) => async () => {
    const consolePushKey = `Push: ${i} of ${chunks.length}`;
    console.log(consolePushKey);
    console.time(consolePushKey);
    await updateDocs({
      indexName: INDEX_ID,
      documents: batch,
      batchSize: BATCH_SIZE,
      client: metricsSearchClient,
    });
    console.timeEnd(consolePushKey);
  });
  await limitConcurrency(tasks, 10);
};

const updateMethods = { addFields, updateBaseModel, addCollections };

export default ModEndpoint(
  async function updateImageSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    const updateMethod = updateMethods[update as keyof typeof updateMethods];
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
