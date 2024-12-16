import { toJson } from '~/utils/json-helpers';
import { clickhouse } from '../clickhouse/client';
import { redis } from '../redis/client';
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
            WHERE createdAt > current_date() - interval '24 hours'

            UNION ALL

            SELECT
              arrayJoin(resourcesUsed) as modelVersionId,
              0 AS failed
            FROM orchestration.textToImageJobs
            WHERE createdAt > current_date() - interval '24 hours'
          )
          GROUP BY modelVersionId
        ) s
        WHERE failed > CAST(requested AS FLOAT) / 2
        AND requested > 10;
      `
      ).map(({ modelVersionId }) => modelVersionId);

      // Store new data
      await redis.hSet(
        'system:features',
        'generation:unstable-resources',
        toJson(affectedResources)
      );
    } catch (error) {
      throw error;
    }
  }
);
