import type { MigrationPackage, EntityMetricEvent } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

type BountyBenefactorRow = {
  bountyId: number;
  userId: number;
  unitAmount: number;
  createdAt: Date;
};

export const bountyBenefactorPackage: MigrationPackage<BountyBenefactorRow> = {
  queryBatchSize: 2000,
  range: createColumnRangeFetcher('BountyBenefactor', 'bountyId', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyBenefactorRow>(
      `SELECT "bountyId", "userId", "unitAmount", "createdAt"
       FROM "BountyBenefactor"
       WHERE "bountyId" >= $1
         AND "bountyId" <= $2
       ORDER BY "bountyId"`,
      [start, end]
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
