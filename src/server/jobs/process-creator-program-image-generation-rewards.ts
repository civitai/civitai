import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { createBuzzTransaction } from '../services/buzz.service';
import { TransactionType } from '../schema/buzz.schema';
import { ModelVersionMeta } from '~/server/schema/model-version.schema';
import { constants } from '~/server/common/constants';
import { uniqBy } from 'lodash-es';

type ModelVersionForGeneratedImagesReward = {
  id: number;
  meta?: ModelVersionMeta;
  modelName: string;
  modelVersionName: string;
  userId: number;
};

export const processCreatorProgramImageGenerationRewards = createJob(
  'creator-program-image-generation-reward-process',
  '0 0 * * *',
  async () => {
    if (!clickhouse) return;

    const [lastUpdate, setLastUpdate] = await getJobDate(
      'creator-program-image-generation-reward-process',
      // Creator program start date:
      new Date('2024-02-02')
    );

    // This may not be 100% accurate as a parameter, but it's good enough for our purposes
    const creatorProgramUsers = await dbWrite.userStripeConnect.findMany({
      where: {
        // Note: It is possible that non-approved users might miss some sort of window here.
        // In all fairness, only approved users should be able to receive rewards.
        status: 'Approved',
      },
    });

    const creatorProgramUserIds = creatorProgramUsers.map((x) => x.userId);

    if (creatorProgramUserIds.length === 0) {
      // await setLastUpdate();
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

    console.log({ modelVersions });

    if (modelVersions.length === 0) {
      // await setLastUpdate();
      return; // No records to process
    }

    const date = dayjs();
    // We grant buzz for the previous month on start of month.
    const isStartOfMonth = date.isSame(date.startOf('month'), 'day');
    const lastMonth = date.subtract(1, 'month').startOf('month');
    const chLastUpdate = dayjs(lastUpdate).toISOString();
    const dateFormat = 'YYYY-MM-DD';

    console.log(chLastUpdate);

    // Get all records that need to be processed
    const modelVersionData = await clickhouse
      .query({
        query: `
          SELECT 
              resourceId as modelVersionId,
              createdAt,
              SUM(1) as generations
          FROM (
              SELECT 
                  arrayJoin(resourcesUsed) as resourceId,
                  createdAt::date as createdAt 
              FROM orchestration.textToImageJobs
              WHERE createdAt >= parseDateTimeBestEffortOrNull('${chLastUpdate}')
          )
          WHERE resourceId IN (${modelVersions.map((x) => x.id).join(',')})
          GROUP BY resourceId, createdAt 
          ORDER BY createdAt DESC;
    `,
        format: 'JSONEachRow',
      })
      .then((x) => x.json<{ modelVersionId: number; createdAt: Date; generations: number }[]>());

    console.log({ modelVersionData });

    await Promise.all(
      modelVersions.map(async (version) => {
        let generationData = modelVersionData
          .filter(
            // Ensure we only record this month's data
            (x) => x.modelVersionId === version.id && dayjs(x.createdAt).isSame(date, 'month')
          )
          .map((d) => ({
            date: dayjs(d.createdAt).format(dateFormat),
            generations: Number(d.generations ?? '0'),
          }));

        if (generationData.length === 0) {
          generationData = [
            {
              date: date.format(dateFormat),
              generations: 0,
            },
          ];
        }

        const existingGenerationData = version.meta?.generationImagesCount ?? [];

        if (isStartOfMonth) {
          // apply the reward:
          const lastMonthGenerations = existingGenerationData
            // Ensures we only grant people with last month stuff.
            .filter((data) => lastMonth.isSame(dayjs(data.date, 'month')))
            .reduce((acc, x) => acc + Number(x.generations), 0);

          if (lastMonthGenerations > 0) {
            await createBuzzTransaction({
              fromAccountId: 0,
              toAccountId: version.userId,
              amount:
                lastMonthGenerations * constants.creatorsProgram.rewards.generatedImageWithResource, // 10 buzz per download
              description: `Early access reward - ${version.modelName} - ${version.modelVersionName}`,
              type: TransactionType.Reward,
              externalTransactionId: `model-version-${
                version.id
              }-generated-images-reward-${lastMonth.format('YYYY-MM')}`,
            });
          }
        }

        const meta = {
          generationImagesCount: isStartOfMonth
            ? generationData
            : uniqBy([...generationData, ...existingGenerationData], 'date'),
        };

        await dbWrite.$executeRaw`
          UPDATE "ModelVersion" SET meta = (COALESCE(meta, '{}') || ${JSON.stringify(
            meta
          )}::jsonb) WHERE id = ${version.id}
        `;
      })
    );

    // await setLastUpdate();
  }
);
