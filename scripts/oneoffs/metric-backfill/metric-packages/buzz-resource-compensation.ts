import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createTimestampRangeFetcher } from './base';

type BuzzResourceCompensationRow = {
  modelId: number | null;
  modelVersionId: number | null;
  toUserId: number;
  amount: number;
  createdAt: Date;
};

export const buzzResourceCompensationPackage: MigrationPackage<BuzzResourceCompensationRow> = {
  queryBatchSize: 86400, // 1 day in seconds
  range: createTimestampRangeFetcher(
    'buzz_resource_compensation',
    'createdAt',
    `createdAt < '${CUTOFF_DATE}'`
  ),

  query: async ({ ch }, { start, end }) => {
    return ch.query<BuzzResourceCompensationRow>(`
      SELECT
        modelId,
        modelVersionId,
        toUserId,
        amount,
        createdAt
      FROM buzz_resource_compensation
      WHERE createdAt < '${CUTOFF_DATE}'
        AND toUnixTimestamp(createdAt) >= ${start}
        AND toUnixTimestamp(createdAt) <= ${end}
      ORDER BY createdAt
    `);
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((row) => {
      if (row.modelId) {
        addMetrics({
          entityType: 'Model',
          entityId: row.modelId,
          userId: row.toUserId,
          metricType: 'earnedAmount',
          metricValue: row.amount,
          createdAt: row.createdAt,
        });
      }

      if (row.modelVersionId) {
        addMetrics({
          entityType: 'ModelVersion',
          entityId: row.modelVersionId,
          userId: row.toUserId,
          metricType: 'earnedAmount',
          metricValue: row.amount,
          createdAt: row.createdAt,
        });
      }
    });
  },
};
