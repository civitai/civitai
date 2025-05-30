import { ModelStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { updateDocs } from '~/server/meilisearch/client';
import { getModelVersionsForSearchIndex } from '~/server/selectors/modelVersion.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { withRetries } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import { dataProcessor } from '~/server/db/db-helpers';

const BATCH_SIZE = 10000;
const INDEX_ID = MODELS_SEARCH_INDEX;
const WHERE = (idOffset: number) => ({
  model: { id: { gt: idOffset }, status: ModelStatus.Published },
  modelVersions: { status: ModelStatus.Published },
});

const schema = z.object({
  update: z.enum(['generationCoverage', 'user', 'nsfw', 'flags']),
});

const updateGenerationCoverage = (idOffset: number) =>
  withRetries(async () => {
    const { model: modelWhere, modelVersions: modelVersionWhere } = WHERE(idOffset);

    const records = await dbWrite.model.findMany({
      where: modelWhere,
      take: BATCH_SIZE,
      select: {
        id: true,
        modelVersions: {
          orderBy: { index: 'asc' },
          select: getModelVersionsForSearchIndex,
          where: modelVersionWhere,
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

    const unavailableGenResources = await getUnavailableResources();
    const updateIndexReadyRecords = records
      .map(({ id, modelVersions }) => {
        const [{ files, ...version }] = modelVersions;
        const canGenerate = modelVersions.some(
          (x) => x.generationCoverage?.covered && unavailableGenResources.indexOf(x.id) === -1
        );

        if (!version) {
          return null;
        }

        return {
          id,
          version: {
            ...version,
            hashes: version.hashes.map((hash) => hash.hash),
          },
          versions: modelVersions.map(({ generationCoverage, files, hashes, ...x }) => ({
            ...x,
            hashes: hashes.map((hash) => hash.hash),
            canGenerate:
              generationCoverage?.covered && unavailableGenResources.indexOf(x.id) === -1,
          })),
          canGenerate,
        };
      })
      .filter(isDefined);

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

const updateUser = (idOffset: number) =>
  withRetries(async () => {
    const { model: modelWhere, modelVersions: modelVersionWhere } = WHERE(idOffset);

    const records = await dbWrite.model.findMany({
      where: modelWhere,
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

async function updateNsfw() {
  await dataProcessor({
    params: { batchSize: 50000, concurrency: 10, start: 0 },
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
          FROM "Model"
        )
        SELECT MIN(id) as start, MAX(id) as end
        FROM "Model"
        JOIN dates d ON d.start = "createdAt" OR d.end = "createdAt";
      `;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      type ModelBase = {
        id: number;
        nsfw: boolean;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ModelBase[]>`
        SELECT
          id,
          "nsfw"
        FROM "Model"
        WHERE id BETWEEN ${start} AND ${end}
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) {
        console.log(`No updates found:  ${start} - ${end}`);
        return;
      }

      const consoleTransformKey = `Transform: ${start} - ${end}`;
      console.log(consoleTransformKey);
      console.time(consoleTransformKey);
      const documents = records;
      console.timeEnd(consoleTransformKey);

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents,
        batchSize: 50000,
      });
      console.timeEnd(consolePushKey);
    },
  });
}

async function updateFlags() {
  await dataProcessor({
    params: { batchSize: 50000, concurrency: 10, start: 0 },
    runContext: {
      on: (event: 'close', listener: () => void) => {
        // noop
      },
    },
    rangeFetcher: async (ctx) => {
      // I guess we ideally want to have dates here but should work a alright.
      const [{ start, end }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
        SELECT
          MIN("modelId") as start,
          MAX("modelId") as end
        FROM "ModelFlag"
      `;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      type ModelWithFlag = {
        modelId: number;
        nameNsfw?: boolean;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ModelWithFlag[]>`
        SELECT fl.*
        FROM "ModelFlag" fl
        JOIN "Model" m ON m."id" = fl."modelId"
        WHERE id BETWEEN ${start} AND ${end}
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) {
        console.log(`No updates found:  ${start} - ${end}`);
        return;
      }

      const documents = records.map(({ modelId, ...flags }) => ({ id: modelId, flags }));

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents,
        batchSize: 100000,
      });
      console.timeEnd(consolePushKey);
    },
  });
}

export default ModEndpoint(
  async function updateModelSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    if (update === 'nsfw') {
      await updateNsfw();
      return res.status(200).json({ ok: true, duration: Date.now() - start });
    }
    if (update === 'flags') {
      await updateFlags();
      return res.status(200).json({ ok: true, duration: Date.now() - start });
    }

    const updateMethod: ((idOffset: number) => Promise<number>) | null =
      update === 'generationCoverage'
        ? updateGenerationCoverage
        : update === 'user'
        ? updateUser
        : null;

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
