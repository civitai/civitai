import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('update-daily-metrics', 'blue');

const METRIC_LAST_UPDATED_DAILY_KEY = 'last-daily-metrics';

export const updateDailyMetricsJob = createJob(
  'update-daily-metrics',
  '0 0 * * *',
  async () => {
    async function updateDailyMetrics(target: 'models' | 'versions') {
      const [tableName, tableId, sourceTableName] =
        target === 'models'
          ? ['ModelMetricDailySummary', 'modelId', 'Model']
          : ['ModelMetricVersionDailySummary', 'modelVersionId', 'ModelVersion'];

      const query = `
        INSERT INTO "${tableName}" ("${tableId}", type, "date", "count")
        SELECT
            m.id,
            'ModelDownload'::"MetricSnapshotType",
            b."date",
            COUNT(*) AS "count"
        FROM
        (
            SELECT
              m.id,
              COALESCE((
                  SELECT MAX(date) FROM "${tableName}"
              ), '2020-01-1'::date) "lastUpdateDate"
            FROM "${sourceTableName}" m
        ) m
        CROSS JOIN LATERAL (
            SELECT t.day::date AS date
            FROM generate_series(m."lastUpdateDate", current_date - interval '1 day', interval '1 day') AS t(day)
        ) b
        JOIN "UserActivity" ua
            ON  ua."createdAt" > b.date AND ua."createdAt" < (b.date + INTERVAL '1 day')
            AND CAST(ua.details ->> '${tableId}' AS INT) = m.id
        GROUP BY m.id, b.date
        ON CONFLICT ("${tableId}", type, date) DO UPDATE
          SET "count" = EXCLUDED."count"
        `;

      await dbWrite.$executeRawUnsafe(query);
    }

    // Update all affected metrics
    // --------------------------------------------
    await updateDailyMetrics('models');
    await updateDailyMetrics('versions');
    log('Updated daily metrics');
  },
  {
    lockExpiration: 10 * 60,
  }
);
