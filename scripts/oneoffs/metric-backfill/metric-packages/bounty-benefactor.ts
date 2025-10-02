import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

type BountyBenefactorRow = {
  bountyId: number;
  userId: number;
  unitAmount: number;
  createdAt: Date;
};

export const bountyBenefactorPackage: MigrationPackage<BountyBenefactorRow> = {
  queryBatchSize: 2000,
  range: createColumnRangeFetcher('BountyBenefactor', 'bountyId', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyBenefactorRow>(
      `SELECT "bountyId", "userId", "unitAmount", "createdAt"
       FROM "BountyBenefactor"
       WHERE "createdAt" < $1
         AND "bountyId" >= $2
         AND "bountyId" <= $3
       ORDER BY "bountyId"`,
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
