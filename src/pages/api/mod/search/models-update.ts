import { ModelStatus } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { MODELS_SEARCH_INDEX } from '../../../../server/common/constants';
import { updateDocs } from '../../../../server/meilisearch/client';
import { getModelVersionsForSearchIndex } from '../../../../server/selectors/modelVersion.selector';
import { userWithCosmeticsSelect } from '../../../../server/selectors/user.selector';
import { withRetries } from '../../../../server/utils/errorHandling';
import { isDefined } from '../../../../utils/type-guards';

const BATCH_SIZE = 10000;
const INDEX_ID = MODELS_SEARCH_INDEX;
const WHERE = (idOffset: number) => ({
  model: { id: { gt: idOffset }, status: ModelStatus.Published },
  modelVersions: { status: ModelStatus.Published },
});

const schema = z.object({
  update: z.enum(['generationCoverage', 'user']),
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
        const [version] = modelVersions;
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

export default ModEndpoint(
  async function updateModelSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
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
