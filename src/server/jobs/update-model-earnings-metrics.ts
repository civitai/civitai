import { createJob, getJobDate } from './job';
import { dbRead } from '~/server/db/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { createLogger } from '~/utils/logging';
import { clickhouse } from '~/server/clickhouse/client';

const log = createLogger('update-model-earnings-metrics', 'magenta');

/**
 * Job to update earnings metrics for models
 * Runs daily since earnings are processed once a day
 * Incrementally updates Redis metrics based on new earnings
 */
// @dev: Instead of having this run on a cron, I think it makes more sense for this to be a fn that gets called at the end of `runPayout` in src\server\jobs\deliver-creator-compensation.ts since that's the only time these values will be changing anyway...Theoretically we might not even need to do a fetch and can instead just hinc the right values from there... Essentially allowing us to remove all of this code
export const updateModelEarningsMetrics = createJob(
  'update-model-earnings-metrics',
  '0 2 * * *', // Run at 2 AM daily
  async (ctx) => {
    const stats = {
      modelsUpdated: 0,
      modelVersionsUpdated: 0,
      timeMs: Date.now(),
    };

    try {
      if (!clickhouse) {
        log('ClickHouse client not configured');
        return { status: 'skipped', reason: 'no-clickhouse' };
      }

      // Get last run date for incremental updates
      const [lastRun, setLastRun] = await getJobDate(
        'last-model-earnings-metrics',
        // Default to yesterday if never run
        new Date(Date.now() - 24 * 60 * 60 * 1000)
      );

      // Query ClickHouse for earnings from buzz_resource_compensation
      // This table is updated daily with earnings data
      const query = `
        SELECT
          modelVersionId,
          SUM(total) as newEarnings
        FROM buzz_resource_compensation
        WHERE date = toStartOfDay(parseDateTimeBestEffort('${lastRun.toISOString()}'))
        GROUP BY modelVersionId
        HAVING newEarnings > 0
      `;

      const response = await clickhouse.query({ query, format: 'JSONEachRow' });
      const rows = await response.json<{ modelVersionId: number; newEarnings: number }[]>();

      if (rows.length === 0) {
        log('No new earnings since last run');
        await setLastRun();
        return stats;
      }

      // Get model IDs for these model versions
      const modelVersionIds = rows.map((r: { modelVersionId: number; newEarnings: number }) => r.modelVersionId);
      const modelVersions = await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE id = ANY(${modelVersionIds})
      `;

      // Create maps for quick lookup
      const versionToModel = new Map(modelVersions.map(mv => [mv.id, mv.modelId]));
      const modelIncrements = new Map<number, number>();

      // Increment model version earnings in Redis
      for (const row of rows) {
        const modelId = versionToModel.get(row.modelVersionId);
        if (!modelId) continue;

        // Increment model version metric
        try {
          await entityMetricRedis.increment(
            'ModelVersion',
            row.modelVersionId,
            'Earned',
            row.newEarnings
          );
          stats.modelVersionsUpdated++;

          // Track increment for model
          const currentIncrement = modelIncrements.get(modelId) || 0;
          modelIncrements.set(modelId, currentIncrement + row.newEarnings);
        } catch (error) {
          log(`Failed to increment ModelVersion ${row.modelVersionId}:`, error);
        }
      }

      // Increment model earnings in Redis
      for (const [modelId, increment] of modelIncrements.entries()) {
        try {
          await entityMetricRedis.increment(
            'Model',
            modelId,
            'Earned',
            increment
          );
          stats.modelsUpdated++;
        } catch (error) {
          log(`Failed to increment Model ${modelId}:`, error);
        }
      }

      // Update last run timestamp
      await setLastRun();

      stats.timeMs = Date.now() - stats.timeMs;
      log(`Updated ${stats.modelsUpdated} models and ${stats.modelVersionsUpdated} model versions in ${stats.timeMs}ms`);

      return stats;
    } catch (error) {
      log('Error updating earnings metrics:', error);
      throw error;
    }
  },
  {
    lockExpiration: 60 * 60, // 1 hour lock
    queue: 'metrics',
  }
);
