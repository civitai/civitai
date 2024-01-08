import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { MODELS_SEARCH_INDEX } from '../../../server/common/constants';
import { updateDocs } from '../../../server/meilisearch/client';
import { ModelStatus } from '@prisma/client';
import { getModelVersionsForSearchIndex } from '../../../server/selectors/modelVersion.selector';
import { isDefined } from '../../../utils/type-guards';
import { withRetries } from '../../../server/utils/errorHandling';

const BATCH_SIZE = 10000;
const INDEX_ID = MODELS_SEARCH_INDEX;

const indexRecords = (idOffset: number) =>
  withRetries(async () => {
    const records = await dbWrite.model.findMany({
      where: { id: { gt: idOffset }, status: ModelStatus.Published },
      take: BATCH_SIZE,
      select: {
        id: true,
        modelVersions: {
          orderBy: { index: 'asc' },
          select: getModelVersionsForSearchIndex,
          where: {
            status: ModelStatus.Published,
          },
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

    const updateIndexReadyRecords = records
      .map(({ id, modelVersions }) => {
        const [version] = modelVersions;
        const canGenerate = modelVersions.some((x) => x.generationCoverage?.covered);

        if (!version) {
          return null;
        }

        return {
          id,
          version,
          versions: modelVersions.map(({ generationCoverage, files, ...x }) => ({
            ...x,
            canGenerate: generationCoverage?.covered,
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

export default ModEndpoint(
  async function updateSearchIndexGenerationCoverage(req: NextApiRequest, res: NextApiResponse) {
    const start = Date.now();
    try {
      let id = -1;
      while (true) {
        const updatedId = await indexRecords(id);
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
