import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from 'dayjs';

const log = createLogger('update-daily-metrics', 'blue');

export const updateDailyMetricsJob = createJob(
  'update-daily-metrics',
  '0 0 * * *',
  async () => {
    const lastRecord = await dbWrite.modelMetricDaily.aggregate({ _max: { date: true } });
    const startDate = dayjs(lastRecord._max?.date ?? new Date(0)).toDate();

    await dbWrite.$executeRaw`
      WITH user_model_downloads as (
        SELECT
          user_id,
          model_id,
          model_version_id,
          MAX(created_at) created_at
        FROM (
          SELECT
            COALESCE(CAST(a."userId" as text), a.details->>'ip') user_id,
            CAST(a.details ->> 'modelId' AS INT) AS model_id,
            CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id,
            a."createdAt" AS created_at
          FROM "UserActivity" a
          WHERE a.activity = 'ModelDownload'
            AND a."createdAt" > ${startDate}::timestamp
            AND a."createdAt" < current_date
        ) t
        JOIN "ModelVersion" mv ON mv.id = t.model_version_id
        GROUP BY user_id, model_id, model_version_id
      ), daily_downloads as (
        SELECT
          model_id,
          model_version_id,
          date_trunc('day', created_at) date,
          count(*) count
        FROM user_model_downloads
        GROUP BY model_id, model_version_id, date_trunc('day', created_at)
      )
      INSERT INTO "ModelMetricDaily" ("modelId", "modelVersionId", type, date, count)
      SELECT
        model_id,
        model_version_id,
        'downloads',
        date,
        count
      FROM daily_downloads
      ON CONFLICT ("modelId", "modelVersionId", type, date) DO UPDATE SET count = excluded.count;
    `;
    log('Updated daily metrics');
  },
  {
    lockExpiration: 10 * 60,
  }
);
