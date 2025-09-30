import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BountyBenefactorRow = {
  bountyId: number;
  userId: number;
  unitAmount: number;
  createdAt: Date;
};

export const bountyBenefactorPackage: MigrationPackage<BountyBenefactorRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BountyBenefactor', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyBenefactorRow>(
      `SELECT "bountyId", "userId", "unitAmount", "createdAt"
       FROM "BountyBenefactor"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((benefactor) => {
      addMetrics(
        {
          entityType: 'Bounty',
          entityId: benefactor.bountyId,
          userId: benefactor.userId,
          metricType: 'benefactorCount',
          metricValue: 1,
          createdAt: benefactor.createdAt,
        },
        {
          entityType: 'Bounty',
          entityId: benefactor.bountyId,
          userId: benefactor.userId,
          metricType: 'unitAmount',
          metricValue: benefactor.unitAmount,
          createdAt: benefactor.createdAt,
        }
      );
    });
  },
};
