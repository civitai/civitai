import { toJson } from '~/utils/json-helpers';
import { clickhouse } from '../clickhouse/client';
import { REDIS_SYS_KEYS, sysRedis } from '../redis/client';
import { createJob } from './job';

export const resourceGenerationAvailability = createJob(
  'resource-gen-availability',
  '*/10 * * * *',
  async () => {
    if (!clickhouse) return;

    try {
      const affectedResources = (
        await clickhouse.$query<{ modelVersionId: number }>`
        SELECT modelVersionId
        FROM (
          SELECT
            modelVersionId,
            COUNT() AS requested,
            SUM(failed) AS failed
          FROM (
            SELECT
              arrayJoin(resourcesUsed) as modelVersionId,
              1 AS failed
            FROM orchestration.failedTextToImageJobs
            WHERE createdAt > current_date() - interval '4 hours'

            UNION ALL

            SELECT
              arrayJoin(resourcesUsed) as modelVersionId,
              0 AS failed
            FROM orchestration.jobs
            WHERE createdAt > current_date() - interval '4 hours'
          )
          GROUP BY modelVersionId
        ) s
        WHERE failed > CAST(requested AS FLOAT) / 2
        AND requested > 10;
      `
      )
        .map(({ modelVersionId }) => modelVersionId)
        // ensure OpenAi id not included in list of affected resources
        .filter((id) => id !== 1733399);

      // Store new data
      await sysRedis.hSet(
        REDIS_SYS_KEYS.SYSTEM.FEATURES,
        'generation:unstable-resources',
        toJson(affectedResources)
      );
    } catch (error) {
      throw error;
    }
  }
);
