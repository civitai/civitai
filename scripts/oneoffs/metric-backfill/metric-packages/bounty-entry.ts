import type { MigrationPackage, EntityMetricEvent } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BountyEntryRow = {
  bountyId: number;
  userId: number;
  createdAt: Date;
};

export const bountyEntryPackage: MigrationPackage<BountyEntryRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BountyEntry', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyEntryRow>(
      `SELECT "bountyId", "userId", "createdAt"
       FROM "BountyEntry"
       WHERE id >= $1
         AND id <= $2`,
      [start, end]
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
