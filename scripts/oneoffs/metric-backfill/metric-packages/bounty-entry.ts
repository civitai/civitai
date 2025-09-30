import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BountyEntryRow = {
  bountyId: number;
  userId: number;
  createdAt: Date;
};

export const bountyEntryPackage: MigrationPackage<BountyEntryRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BountyEntry', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyEntryRow>(
      `SELECT "bountyId", "userId", "createdAt"
       FROM "BountyEntry"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((entry) => {
      addMetrics({
        entityType: 'Bounty',
        entityId: entry.bountyId,
        userId: entry.userId,
        metricType: 'entryCount',
        metricValue: 1,
        createdAt: entry.createdAt,
      });
    });
  },
};
