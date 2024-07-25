import { createJob } from './job';
import { clickhouse } from '~/server/clickhouse/client';

export const cacheCleanup = createJob(
  'update-buzz-resource-compensation',
  '*/1 * * * *',
  async () => {
    if (!clickhouse) return;

    await clickhouse.query({
      query: `
        INSERT INTO buzz_resource_compensation (date, modelVersionId, comp, tip, total)
        SELECT
          toStartOfDay(createdAt) as date,
          modelVersionId,
          FLOOR(SUM(comp)) as comp,
          FLOOR(SUM(tip)) AS tip,
          comp + tip as total
        FROM (
          SELECT
          modelVersionId,
          createdAt,
          max(jobCost) * 0.25 as creator_comp,
          max(creatorsTip) as full_tip,
          max(resource_count) as resource_count,
          creator_comp * if(max(isBaseModel) = 1, 0.25, 0) as base_model_comp,
          creator_comp * 0.75 / resource_count as resource_comp,
          base_model_comp + resource_comp as comp,
          full_tip / resource_count as tip,
          comp + tip as total
          FROM (
            SELECT
              rj.modelVersionId as modelVersionId,
              rj.resource_count as resource_count,
              rj.createdAt as createdAt,
              rj.jobCost as jobCost,
              rj.jobId as jobId,
              rj.creatorsTip as creatorsTip,
              m.type = 'Checkpoint' as isBaseModel
            FROM (
              SELECT
                arrayJoin(resourcesUsed) AS modelVersionId,
                length(arrayFilter(x -> NOT x IN (250708, 250712, 106916), resourcesUsed)) as resource_count,
                createdAt,
                jobCost,
                jobId,
                creatorsTip
              FROM orchestration.textToImageJobs
              WHERE createdAt BETWEEN toStartOfDay(subtractDays(now(), 1)) AND toStartOfDay(now())
                AND modelVersionId NOT IN (250708, 250712, 106916)
            ) rj
            JOIN civitai_pg.ModelVersion mv ON mv.id = rj.modelVersionId
            JOIN civitai_pg.Model m ON m.id = mv.modelId
          ) resource_job_details
          GROUP BY modelVersionId, jobId, createdAt
        ) resource_job_values
        GROUP BY date, modelVersionId
        HAVING total >= 1
        ORDER BY total DESC;
      `,
      format: 'JSONEachRow',
    });

    await clickhouse.query({
      query: 'OPTIMIZE TABLE buzz_resource_compensation;',
      format: 'JSONEachRow',
    });
  }
);
