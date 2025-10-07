import type { MigrationPackage } from '../types';
import { CUTOFF_DATE, START_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BountyRow = {
  userId: number;
  createdAt: Date;
};

export const bountyPackage: MigrationPackage<BountyRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('Bounty', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyRow>(
      `SELECT "userId", "createdAt"
       FROM "Bounty"
       WHERE id >= $1
         AND id <= $2
       ORDER BY id`,
      [start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((bounty) => {
      addMetrics({
        entityType: 'User',
        entityId: bounty.userId,
        userId: bounty.userId,
        metricType: 'bountyCount',
        metricValue: 1,
        createdAt: bounty.createdAt,
      });
    });
  },
};
