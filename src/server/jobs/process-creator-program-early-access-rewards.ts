import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { isEarlyAccess } from '../utils/early-access-helpers';
import { createBuzzTransaction } from '../services/buzz.service';
import { TransactionType } from '../schema/buzz.schema';
import { ModelVersionMeta } from '~/server/schema/model-version.schema';
import { constants } from '~/server/common/constants';

type ModelVersionForEarlyAccessReward = {
  id: number;
  createdAt: Date;
  publishedAt: Date;
  earlyAccessTimeFrame: number;
  meta: ModelVersionMeta;
  modelName: string;
  modelVersionName: string;
  userId: number;
};

export const processCreatorProgramEarlyAccessRewards = createJob(
  'creator-program-early-access-rewards-process',
  '0 0 * * *',
  async () => {
    if (!clickhouse) return;

    const [lastUpdate, setLastUpdate] = await getJobDate(
      'creator-program-early-access-rewards-process',
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
      await setLastUpdate();
      return;
    }

    const modelVersions = await dbWrite.$queryRaw<ModelVersionForEarlyAccessReward[]>`
      SELECT
        mv.id,
        mv."createdAt",
        mv."publishedAt",
        mv."earlyAccessTimeFrame",
        mv."meta",
        m.name as "modelName",
        mv.name as "modelVersionName",
        m."userId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv."status" = 'Published'
        AND mv."earlyAccessTimeFrame" > 0
        AND m."userId" IN (${Prisma.join(creatorProgramUserIds, ',')})
        AND GREATEST(mv."createdAt", mv."publishedAt") 
          + (mv."earlyAccessTimeFrame" || ' day')::INTERVAL
          >= ${lastUpdate};
    `;

    if (modelVersions.length === 0) {
      await setLastUpdate();
      return; // No records to process
    }

    // Get all records that need to be processed
    const modelVersionData = await clickhouse
      .query({
        query: `
          SELECT
            modelVersionId,
            createdDate,
            uniqMerge(users_state) AS downloads
          FROM daily_downloads_unique_mv
          WHERE modelVersionId IN (${modelVersions.map(({ id }) => id).join(',')})
          AND createdDate > subtractDays(toStartOfDay(now()), 14)
          GROUP BY modelVersionId, createdDate
          ORDER BY createdDate DESC;
    `,
        format: 'JSONEachRow',
      })
      .then((x) => x.json<{ modelVersionId: number; createdDate: Date; downloads: number }[]>());

    await Promise.all(
      modelVersions.map(async (version) => {
        // First, check that it's still early access:
        const isEarlyAccessBool = isEarlyAccess({
          versionCreatedAt: version.createdAt,
          earlyAccessTimeframe: version.earlyAccessTimeFrame,
          publishedAt: version.publishedAt,
        });

        const downloadData = modelVersionData
          .filter(
            (x) =>
              x.modelVersionId === version.id &&
              dayjs(x.createdDate).endOf('day').isAfter(version.publishedAt) &&
              dayjs(x.createdDate)
                .startOf('day')
                .isBefore(dayjs(version.publishedAt).add(version.earlyAccessTimeFrame, 'day'))
          )
          .map((d) => ({
            date: d.createdDate,
            downloads: Number(d.downloads ?? '0'),
          }));

        if (downloadData.length === 0) {
          return;
        }

        if (!isEarlyAccessBool) {
          // apply the reward:
          const totalDownloads = downloadData.reduce((acc, x) => acc + Number(x.downloads), 0);

          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: version.userId,
            amount: totalDownloads * constants.creatorsProgram.rewards.earlyAccessUniqueDownload,
            description: `Early access reward - ${version.modelName} - ${version.modelVersionName}`,
            type: TransactionType.Reward,
            externalTransactionId: `model-version-${version.id}-early-access-reward`,
          });
        }

        const meta = {
          earlyAccessDownloadData: downloadData,
        };

        await dbWrite.$executeRaw`
          UPDATE "ModelVersion" SET meta = (COALESCE(meta, '{}') || ${JSON.stringify(
            meta
          )}::jsonb) WHERE id = ${version.id}
        `;
      })
    );

    await setLastUpdate();
  }
);
