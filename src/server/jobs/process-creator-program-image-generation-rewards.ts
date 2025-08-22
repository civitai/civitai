import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from '~/shared/utils/dayjs';
import { Prisma } from '@prisma/client';
import { createBuzzTransactionMany } from '../services/buzz.service';
import { TransactionType } from '../schema/buzz.schema';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import { constants } from '~/server/common/constants';
import { chunk } from 'lodash-es';
import { isDefined } from '~/utils/type-guards';
import { withRetries } from '~/server/utils/errorHandling';

type ModelVersionForGeneratedImagesReward = {
  id: number;
  meta?: ModelVersionMeta;
  modelName: string;
  modelVersionName: string;
  userId: number;
};

type ModelVersionRow = {
  modelVersionId: number;
  createdAt: Date;
  generations: number;
};

export const processCreatorProgramImageGenerationRewards = createJob(
  'creator-program-image-generation-reward-process',
  // Job runs once a month.
  '0 0 1 * *',
  async () => {
    if (!clickhouse) return;

    const [lastUpdate, setLastUpdate] = await getJobDate(
      'creator-program-image-generation-reward-process',
      // Creator program start date:
      new Date('2024-02-02')
    );

    // This may not be 100% accurate as a parameter, but it's good enough for our purposes
    const creatorProgramUsers = await dbWrite.userPaymentConfiguration.findMany({
      where: {
        // Note: It is possible that non-approved users might miss some sort of window here.
        // In all fairness, only approved users should be able to receive rewards.
        OR: [
          {
            tipaltiPaymentsEnabled: true,
          },
        ],
      },
    });

    const creatorProgramUserIds = creatorProgramUsers.map((x) => x.userId);

    if (creatorProgramUserIds.length === 0) {
      await setLastUpdate();
      return;
    }

    const modelVersions = await dbWrite.$queryRaw<ModelVersionForGeneratedImagesReward[]>`
      SELECT
        mv.id,
        mv.meta,
        m."userId",
        m.name as "modelName",
        mv.name as "modelVersionName"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv."status" = 'Published'
        AND m."userId" IN (${Prisma.join(creatorProgramUserIds, ',')})
    `;

    if (modelVersions.length === 0) {
      await setLastUpdate();
      return; // No records to process
    }

    const date = dayjs();
    // We grant buzz for the previous month on start of month.
    // Extract 26 days in case 1 month  = 30 days and may break february.
    const lastMonth = date.subtract(26, 'day').startOf('month');

    // Get all records that need to be processed
    const modelVersionData = await clickhouse.$query<ModelVersionRow>`
      SELECT
        resourceId as modelVersionId,
        createdAt,
        SUM(1) as generations
      FROM (
        SELECT
          arrayJoin(resourcesUsed) as resourceId,
          createdAt::date as createdAt
        FROM orchestration.jobs
        WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')
        AND createdAt >= ${lastUpdate}
      )
      WHERE resourceId IN (${modelVersions.map((x) => x.id)})
      GROUP BY resourceId, createdAt
      ORDER BY createdAt DESC;
    `;

    const transactions = modelVersions
      .map((version) => {
        const prevMonthGenerationCount = modelVersionData
          .filter(
            // only take last month records to grant that buzz.
            (x) => x.modelVersionId === version.id && dayjs(x.createdAt).isSame(lastMonth, 'month')
          )
          .reduce((acc, x) => acc + Number(x.generations), 0);

        const amount = Math.ceil(
          prevMonthGenerationCount * constants.creatorsProgram.rewards.generatedImageWithResource
        );

        if (amount === 0) {
          return null;
        }

        return {
          fromAccountId: 0,
          toAccountId: version.userId,
          amount,
          description: `(${lastMonth.format('MMM, YYYY')}) Monthly generation reward for - ${
            version.modelName
          } - ${version.modelVersionName}`,
          type: TransactionType.Reward,
          externalTransactionId: `model-version-${
            version.id
          }-generated-images-reward-${lastMonth.format('YYYY-MM')}`,
        };
      })
      .filter(isDefined);

    // Batch those up:
    const batchSize = 250;
    const batches = chunk(transactions, batchSize);
    let i = 0;
    for (const batch of batches) {
      console.log(
        `Creating rewards ${i} to ${Math.min(i + batchSize, transactions.length)} of ${
          transactions.length
        }`
      );
      await withRetries(() => createBuzzTransactionMany(batch), 1);
      i += batchSize;
    }

    await setLastUpdate();
  }
);
