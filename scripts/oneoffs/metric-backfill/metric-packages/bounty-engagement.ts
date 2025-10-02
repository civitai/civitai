import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

type BountyEngagementRow = {
  bountyId: number;
  userId: number;
  type: string;
  createdAt: Date;
};

export const bountyEngagementPackage: MigrationPackage<BountyEngagementRow> = {
  queryBatchSize: 2000,
  range: createColumnRangeFetcher('BountyEngagement', 'bountyId', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyEngagementRow>(
      `SELECT "bountyId", "userId", "type", "createdAt"
       FROM "BountyEngagement"
       WHERE "createdAt" < $1
         AND "bountyId" >= $2
         AND "bountyId" <= $3
       ORDER BY "bountyId"`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((engagement) => {
      const metricType = engagement.type === 'Favorite' ? 'favoriteCount' : 'trackCount';

      addMetrics({
        entityType: 'Bounty',
        entityId: engagement.bountyId,
        userId: engagement.userId,
        metricType,
        metricValue: 1,
        createdAt: engagement.createdAt,
      });
    });
  },
};
