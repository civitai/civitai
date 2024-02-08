import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { BuzzEventLog } from '~/server/rewards/base.reward';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { isEarlyAccess } from '../utils/early-access-helpers';
import { createBuzzTransaction } from '../services/buzz.service';
import { TransactionType } from '../schema/buzz.schema';

type ModelVersionForEarlyAccessReward = {
  id: number;
  createdAt: Date;
  publishedAt: Date;
  earlyAccessTimeFrame: number;
  meta: MixedObject;
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
    const now = new Date();
    const chLastUpdate = dayjs(lastUpdate).toISOString();

    // This may not be 100% accurate as a parameter, but it's good enough for our purposes
    const creatorProgramUsers = await dbWrite.userStripeConnect.findMany({
      where: {
        status: 'Approved',
      },
    });
    const creatorProgramUserIds = creatorProgramUsers.map((x) => x.userId);

    if (creatorProgramUserIds.length === 0) {
      return;
    }

    const modelVersions = await dbWrite.$queryRaw<ModelVersionForEarlyAccessReward[]>`
      SELECT
        id,
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
          > ${chLastUpdate};
    `;

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

    console.log(modelVersionData);

    await Promise.all(
      modelVersions.map(async (version) => {
        // First, check that it's still early access:
        const isEarlyAccessBool = isEarlyAccess({
          versionCreatedAt: version.createdAt,
          earlyAccessTimeframe: version.earlyAccessTimeFrame,
          publishedAt: version.publishedAt,
        });

        const downloadData = modelVersionData
          .filter((x) => x.modelVersionId === version.id && x.createdDate >= version.publishedAt)
          .map((d) => ({
            date: d.createdDate,
            downloads: d.downloads,
          }));

        if (downloadData.length === 0) {
          return;
        }

        if (!isEarlyAccessBool) {
          // apply the reward:
          const totalDownloads = downloadData.reduce((acc, x) => acc + x.downloads, 0);

          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: version.userId,
            amount: totalDownloads * 10, // 10 buzz per download
            description: `Early access reward - ${version.modelName} v${version.modelVersionName}`,
            type: TransactionType.Reward,
            externalTransactionId: `model-version-${version.id}-early-access-reward`,
          });
        }

        await dbWrite.modelVersion.update({
          where: { id: version.id },
          data: {
            meta: {
              ...version.meta,
              earlyAccessDownloadData: downloadData,
            },
          },
        });
      })
    );
  }
);
