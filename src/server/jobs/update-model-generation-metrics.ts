import { createJob, getJobDate } from './job';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { createLogger } from '~/utils/logging';
import { chunk } from 'lodash-es';

const log = createLogger('update-model-generation-metrics', 'cyan');

/**
 * Job to incrementally update generation counts from ClickHouse to Redis
 * Runs hourly to keep generation metrics up to date
 * Uses lastRun tracking to only process new generations
 */
export const updateModelGenerationMetrics = createJob(
  'update-model-generation-metrics',
  '0 * * * *', // Run every hour
  async (ctx) => {
    if (!clickhouse) {
      log('ClickHouse client not configured');
      return { status: 'skipped', reason: 'no-clickhouse' };
    }

    const stats = {
      modelsUpdated: 0,
      modelVersionsUpdated: 0,
      timeMs: Date.now(),
    };

    try {
      // Get last run date for incremental updates
      const [lastRun, setLastRun] = await getJobDate(
        'last-model-generation-metrics',
        // Default to 1 hour ago if never run
        new Date(Date.now() - 60 * 60 * 1000)
      );

      // Get new generation counts since last run
      const query = `
        SELECT
          modelVersionId,
          COUNT(*) as newGenerations
        FROM (
          SELECT
            arrayJoin(resourcesUsed) as modelVersionId
          FROM orchestration.jobs
          WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')
            AND createdAt > parseDateTimeBestEffort('${lastRun.toISOString()}')
            AND createdAt <= now()
        )
        GROUP BY modelVersionId
        HAVING newGenerations > 0
      `;

      // @dev: I believe we have a $query method that does all the typing and parsing without having to do all of this boilerplate
      const response = await clickhouse.query({ query, format: 'JSONEachRow' });
      const rows = await response.json<{ modelVersionId: number; newGenerations: number }[]>();

      if (rows.length === 0) {
        log('No new generations since last run');
        await setLastRun();
        return stats;
      }

      // Get model IDs for these model versions
      const modelVersionIds = rows.map(r => r.modelVersionId);
      const modelVersions = await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE id = ANY(${modelVersionIds})
      `;

      // Create maps for quick lookup
      const versionToModel = new Map(modelVersions.map(mv => [mv.id, mv.modelId]));
      const modelIncrements = new Map<number, number>();

      // Increment model version counts in Redis
      for (const row of rows) {
        const modelId = versionToModel.get(row.modelVersionId);
        if (!modelId) continue;

        // Increment model version metric
        try {
          await entityMetricRedis.increment(
            'ModelVersion',
            row.modelVersionId,
            'Generation',
            row.newGenerations
          );
          stats.modelVersionsUpdated++;

          // Track increment for model
          const currentIncrement = modelIncrements.get(modelId) || 0;
          modelIncrements.set(modelId, currentIncrement + row.newGenerations);
        } catch (error) {
          log(`Failed to increment ModelVersion ${row.modelVersionId}:`, error);
        }
      }

      // Increment model counts in Redis
      for (const [modelId, increment] of modelIncrements.entries()) {
        try {
          await entityMetricRedis.increment(
            'Model',
            modelId,
            'Generation',
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
      log(`Incremented ${stats.modelsUpdated} models and ${stats.modelVersionsUpdated} model versions in ${stats.timeMs}ms`);

      return stats;
    } catch (error) {
      log('Error updating generation metrics:', error);
      throw error;
    }
  },
  {
    lockExpiration: 60 * 60, // 1 hour lock
    queue: 'metrics',
  }
);
