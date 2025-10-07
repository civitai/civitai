import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';

export const orchestrationJobsPackage: MigrationPackage<any> = {
  queryBatchSize: 60*60, // 1 hour in seconds
  range: async () => ({
    start: Math.floor(new Date(START_DATE).getTime() / 1000),
    end: Math.ceil(new Date(CUTOFF_DATE).getTime() / 1000),
  }),

  query: async (_ctx, { start, end }) => {
    return [{start, end}];
  },

  processor: async ({ ch, rows, dryRun }) => {
    const { start, end } = rows[0];
    const insert = !dryRun ? 'INSERT INTO entityMetricEvents_testing (entityType, entityId, userId, metricType, metricValue, createdAt)' : '';
    await ch.query(`
      ${insert}
      SELECT
        tupleElement(x, 1) AS entityType,
        tupleElement(x, 2) AS entityId,
        userId,
        'generationCount' AS metricType,
        metricValue,
        createdAt
      FROM (
        SELECT
          mv.modelId,
          t.modelVersionId,
          t.metricValue,
          t.userId,
          t.createdAt
        FROM (
          SELECT
            arrayJoin(resourcesUsed) AS modelVersionId,
            createdAt,
            if(blobsCount = 0, 1, blobsCount) AS metricValue,
            userId
          FROM orchestration.jobs
          WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy', 'comfyVideoGen')
            AND createdAt >= toDateTime(${start}) AND createdAt <= toDateTime(${end})
            AND modelVersionId NOT IN (250708, 250712, 106916)
        ) t
        INNER JOIN civitai_pg.ModelVersion mv ON mv.id = t.modelVersionId
      ) j
      ARRAY JOIN
        [ tuple('Model', toString(j.modelId)), tuple('ModelVersion', toString(j.modelVersionId)) ] AS x
    `);
  },
};
