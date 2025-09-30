import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type TagEngagementRow = {
  tagId: number;
  userId: number;
  type: string;
  createdAt: Date;
};

export const tagEngagementPackage: MigrationPackage<TagEngagementRow> = {
  queryBatchSize: 5000,
  range: createIdRangeFetcher('TagEngagement', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<TagEngagementRow>(
      `SELECT "tagId", "userId", "type", "createdAt"
       FROM "TagEngagement"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((engagement) => {
      const metricType = engagement.type === 'Hide' ? 'hiddenCount' : 'followerCount';

      addMetrics({
        entityType: 'Tag',
        entityId: engagement.tagId,
        userId: engagement.userId,
        metricType,
        metricValue: 1,
        createdAt: engagement.createdAt,
      });
    });
  },
};
