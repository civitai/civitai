import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createTimestampRangeFetcher } from './base';

export const modelVersionEventsPackage: MigrationPackage<any> = {
  queryBatchSize: 86400, // 1 day in seconds
  range: createTimestampRangeFetcher(
    'modelVersionEvents',
    'time',
    `type = 'Download' AND time >= parseDateTimeBestEffort('${START_DATE}') AND time < parseDateTimeBestEffort('${CUTOFF_DATE}')`
  ),

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
        'downloadCount' AS metricType,
        1 AS metricValue,
        time AS createdAt
      FROM modelVersionEvents
      ARRAY JOIN
        [ tuple('Model', toString(modelId)), tuple('ModelVersion', toString(modelVersionId)) ] AS x
      WHERE type = 'Download'
        AND toUnixTimestamp(time) >= ${start}
        AND toUnixTimestamp(time) <= ${end}
        AND userId != -1
        AND CAST(tupleElement(x, 2) AS UInt32) != 0
    `);
  },
};
