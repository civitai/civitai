import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createTimestampRangeFetcher } from './base';

type ModelVersionEventRow = {
  modelId: number;
  modelVersionId: number;
  userId: number;
  time: Date;
};

export const modelVersionEventsPackage: MigrationPackage<ModelVersionEventRow> = {
  queryBatchSize: 86400, // 1 day in seconds
  range: createTimestampRangeFetcher(
    'modelVersionEvents',
    'time',
    `type = 'Download' AND time < '${CUTOFF_DATE}'`
  ),

  query: async ({ ch }, { start, end }) => {
    return ch.query<ModelVersionEventRow>(`
      SELECT modelId, modelVersionId, userId, time
      FROM modelVersionEvents
      WHERE type = 'Download'
        AND time < '${CUTOFF_DATE}'
        AND toUnixTimestamp(time) >= ${start}
        AND toUnixTimestamp(time) <= ${end}
      ORDER BY time
    `);
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((row) => {
      addMetrics(
        {
          entityType: 'Model',
          entityId: row.modelId,
          userId: row.userId,
          metricType: 'downloadCount',
          metricValue: 1,
          createdAt: row.time,
        },
        {
          entityType: 'ModelVersion',
          entityId: row.modelVersionId,
          userId: row.userId,
          metricType: 'downloadCount',
          metricValue: 1,
          createdAt: row.time,
        }
      );
    });
  },
};
