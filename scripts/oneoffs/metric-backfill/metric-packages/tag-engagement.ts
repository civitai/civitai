import type { MigrationPackage } from '../types';
import { CUTOFF_DATE, START_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

type TagEngagementRow = {
  tagId: number;
  userId: number;
  type: string;
  createdAt: Date;
};

export const tagEngagementPackage: MigrationPackage<TagEngagementRow> = {
  queryBatchSize: 5000,
  range: createColumnRangeFetcher('TagEngagement', 'tagId', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<TagEngagementRow>(
      `SELECT "tagId", "userId", "type", "createdAt"
       FROM "TagEngagement"
       WHERE "createdAt" >= $1
         AND "createdAt" < $2
         AND "tagId" >= $3
         AND "tagId" <= $4
       ORDER BY "tagId"`,
      [START_DATE, CUTOFF_DATE, start, end]
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
