import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BuzzTipRow = {
  entityType: string;
  entityId: number;
  toUserId: number;
  fromUserId: number;
  amount: number;
  createdAt: Date;
};

export const buzzTipPackage: MigrationPackage<BuzzTipRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BuzzTip', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BuzzTipRow>(
      `SELECT "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
       FROM "BuzzTip"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((tip) => {
      // Tips received by the entity
      if (tip.entityType === 'User') {
        addMetrics(
          {
            entityType: 'User',
            entityId: tip.toUserId,
            userId: tip.fromUserId,
            metricType: 'tippedCount',
            metricValue: 1,
            createdAt: tip.createdAt,
          },
          {
            entityType: 'User',
            entityId: tip.toUserId,
            userId: tip.fromUserId,
            metricType: 'tippedAmount',
            metricValue: tip.amount,
            createdAt: tip.createdAt,
          }
        );
      } else {
        addMetrics(
          {
            entityType: tip.entityType,
            entityId: tip.entityId,
            userId: tip.fromUserId,
            metricType: 'tippedCount',
            metricValue: 1,
            createdAt: tip.createdAt,
          },
          {
            entityType: tip.entityType,
            entityId: tip.entityId,
            userId: tip.fromUserId,
            metricType: 'tippedAmount',
            metricValue: tip.amount,
            createdAt: tip.createdAt,
          }
        );
      }

      // Tips given by user
      addMetrics(
        {
          entityType: 'User',
          entityId: tip.fromUserId,
          userId: tip.fromUserId,
          metricType: 'tipsGivenCount',
          metricValue: 1,
          createdAt: tip.createdAt,
        },
        {
          entityType: 'User',
          entityId: tip.fromUserId,
          userId: tip.fromUserId,
          metricType: 'tipsGivenAmount',
          metricValue: tip.amount,
          createdAt: tip.createdAt,
        }
      );
    });
  },
};
