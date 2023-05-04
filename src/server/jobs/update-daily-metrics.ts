import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from 'dayjs';
import { clickhouse } from '../clickhouse/client';
import { Prisma } from '@prisma/client';

const log = createLogger('update-daily-metrics', 'blue');

async function updateMetrics(date: Date) {
  const affectedModelVersionsResponse = await clickhouse?.query({
    query: `SELECT modelId, modelVersionId, COUNT(*) AS count
      FROM modelVersionEvents
      WHERE time >= {startDate: Date}
      AND type = 'Download'
      GROUP BY modelId, modelVersionId;`,
    query_params: {
      startDate: dayjs(date).format('YYYY-MM-DD'),
    },
    format: 'JSONEachRow',
  });

  if (affectedModelVersionsResponse) {
    const affectedModelVersions = (await affectedModelVersionsResponse.json()) as [
      {
        modelId: number;
        modelVersionId: number;
        count: string;
      }
    ];

    let succeeded = 0;
    let failed = 0;

    for (const affectedModelVersion of affectedModelVersions) {
      try {
        await dbWrite.$executeRaw`
          INSERT INTO "ModelMetricDaily" ("modelId", "modelVersionId", type, date, count)
          VALUES (${affectedModelVersion.modelId}, ${
          affectedModelVersion.modelVersionId
        }, 'donwloads', ${date}::date, ${parseInt(affectedModelVersion.count)})
          ON CONFLICT ("modelId", "modelVersionId", type, date) DO UPDATE SET count = excluded.count;
        `;

        succeeded += 1;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError) {
          if (e.code === 'P2010') {
            // This model or modelVersion does not exist, ignore for legitimate reasons
            failed += 1;
            continue;
          }
        }

        throw e;
      }
    }

    log(`Updated ${succeeded} daily metrics with ${failed} failed metrics;`);
  }
}

export const updateDailyMetricsJob = createJob(
  'update-daily-metrics',
  '0 * * * *', // refresh once per hour
  async () => {
    const lastRecord = await dbWrite.modelMetricDaily.aggregate({ _max: { date: true } });
    const date = lastRecord._max?.date ?? new Date(0);

    await updateMetrics(date);
  },
  {
    lockExpiration: 10 * 60,
  }
);

export const updateYesterdaysDailyMetricsJob = createJob(
  'update-yesterdays-daily-metrics',
  '15 0 * *', // 15 minutes after mindnight, we'll refresh yesterdays daily metrics
  async () => {
    const date = dayjs(new Date()).subtract(1, 'day').toDate();

    await updateMetrics(date);
  },
  {
    lockExpiration: 10 * 60,
  }
);
