import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createTimestampPgRangeFetcher, TIME_FETCHER_BATCH } from './base';

type BuzzTipRow = {
  entityType: 'Article' | 'Post' | 'Image' | 'Model';
  entityId: number;
  toUserId: number;
  fromUserId: number;
  amount: number;
  createdAt: Date;
};

export const buzzTipPackage: MigrationPackage<BuzzTipRow> = {
  queryBatchSize: 2*TIME_FETCHER_BATCH.day,
  range: createTimestampPgRangeFetcher('BuzzTip', 'createdAt', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}' AND "entityType" != 'Image'`),
  query: async ({ pg }, { start, end }) => {
    return pg.query<BuzzTipRow>(
      `SELECT "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
       FROM "BuzzTip"
       WHERE
        extract(epoch from "createdAt") >= $1
        AND extract(epoch from "createdAt") <= $2
      `,
      [start, end]
    );
  },
  processor: ({ rows, addMetrics }) => {
    rows.forEach((tip) => {
      // Tip given to entity
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

      // Tips given to target user
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
