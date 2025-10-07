import type { MigrationPackage } from '../types';
import { CUTOFF_DATE, START_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

type UserEngagementRow = {
  userId: number;
  targetUserId: number;
  type: string;
  createdAt: Date;
};

export const userEngagementPackage: MigrationPackage<UserEngagementRow> = {
  queryBatchSize: 5000,
  range: createColumnRangeFetcher('UserEngagement', 'userId', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<UserEngagementRow>(
      `SELECT "userId", "targetUserId", "type", "createdAt"
       FROM "UserEngagement"
       WHERE "createdAt" >= $1
         AND "createdAt" < $2
         AND "userId" >= $3
         AND "userId" <= $4
       ORDER BY "userId"`,
      [START_DATE, CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((engagement) => {
      if (engagement.type === 'Follow') {
        // followingCount (from perspective of user doing the following)
        addMetrics(
          {
            entityType: 'User',
            entityId: engagement.userId,
            userId: engagement.userId,
            metricType: 'followingCount',
            metricValue: 1,
            createdAt: engagement.createdAt,
          },
          // followerCount (from perspective of user receiving the follow)
          {
            entityType: 'User',
            entityId: engagement.targetUserId,
            userId: engagement.userId,
            metricType: 'followerCount',
            metricValue: 1,
            createdAt: engagement.createdAt,
          }
        );
      } else if (engagement.type === 'Hide') {
        // hiddenCount
        addMetrics({
          entityType: 'User',
          entityId: engagement.targetUserId,
          userId: engagement.userId,
          metricType: 'hiddenCount',
          metricValue: 1,
          createdAt: engagement.createdAt,
        });
      }
    });
  },
};
