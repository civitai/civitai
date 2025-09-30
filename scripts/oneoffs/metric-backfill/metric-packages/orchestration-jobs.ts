import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createTimestampRangeFetcher } from './base';

type OrchestrationJobRow = {
  modelId: number;
  modelVersionId: number;
  userId: number;
  createdAt: Date;
};

export const orchestrationJobsPackage: MigrationPackage<OrchestrationJobRow> = {
  queryBatchSize: 86400, // 1 day in seconds
  range: createTimestampRangeFetcher(
    'orchestration.jobs',
    'createdAt',
    `type = 'GenerateImage' AND status = 'Completed' AND createdAt < '${CUTOFF_DATE}'`
  ),

  query: async ({ ch }, { start, end }) => {
    return ch.query<OrchestrationJobRow>(`
      SELECT
        JSONExtractInt(params, 'modelId') as modelId,
        JSONExtractInt(params, 'modelVersionId') as modelVersionId,
        userId,
        createdAt
      FROM orchestration.jobs
      WHERE type = 'GenerateImage'
        AND status = 'Completed'
        AND createdAt < '${CUTOFF_DATE}'
        AND toUnixTimestamp(createdAt) >= ${start}
        AND toUnixTimestamp(createdAt) <= ${end}
      ORDER BY createdAt
    `);
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((row) => {
      // Only add metrics if we have valid model IDs
      if (row.modelId && row.modelVersionId) {
        addMetrics(
          {
            entityType: 'Model',
            entityId: row.modelId,
            userId: row.userId,
            metricType: 'generationCount',
            metricValue: 1,
            createdAt: row.createdAt,
          },
          {
            entityType: 'ModelVersion',
            entityId: row.modelVersionId,
            userId: row.userId,
            metricType: 'generationCount',
            metricValue: 1,
            createdAt: row.createdAt,
          }
        );
      }
    });
  },
};
