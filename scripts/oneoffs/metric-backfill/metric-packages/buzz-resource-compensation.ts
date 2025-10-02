import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createTimestampRangeFetcher, TIME_FETCHER_BATCH } from './base';

type BuzzResourceCompensationRow = {
  modelVersionId: number;
  total: number;
  date: Date;
};

export const buzzResourceCompensationPackage: MigrationPackage<BuzzResourceCompensationRow> = {
  queryBatchSize: TIME_FETCHER_BATCH.day,
  range: createTimestampRangeFetcher(
    'buzz_resource_compensation',
    'date'
  ),

  query: async ({ ch }, { start, end }) => {
    return ch.query<BuzzResourceCompensationRow>(`
      SELECT
        modelVersionId,
        total,
        date
      FROM buzz_resource_compensation FINAL
      WHERE toUnixTimestamp(date) >= ${start}
        AND toUnixTimestamp(date) <= ${end}
    `);
  },

  processor: async ({ rows, addMetrics, pg }) => {
    // Add version metrics
    addMetrics(rows.map((row) => ({
      entityType: 'ModelVersion',
      entityId: row.modelVersionId,
      userId: 0,
      metricType: 'earnedAmount',
      metricValue: row.total,
      createdAt: row.date,
    })));

    // Get models
    const models = await pg.query<{ modelId: number, modelVersionId: number }>(`
      SELECT
        "modelId",
        "id" as "modelVersionId"
      FROM "ModelVersion"
      WHERE "id" = ANY($1)
    `, [rows.map(r => r.modelVersionId)]);
    const modelMap = new Map(models.map(m => [m.modelVersionId, m.modelId]));
    const modelEarnings: Map<number, number> = new Map();
    for (const row of rows) {
      const modelId = modelMap.get(row.modelVersionId);
      if (!modelId) return;
      const prev = modelEarnings.get(modelId) ?? 0;
      modelEarnings.set(modelId, prev + row.total);
    }

    // Add model metrics
    addMetrics(Array.from(modelEarnings.entries()).map(([modelId, total]) => ({
      entityType: 'Model',
      entityId: modelId,
      userId: 0,
      metricType: 'earnedAmount',
      metricValue: total,
      createdAt: rows[0].date,
    })));
  },
};
