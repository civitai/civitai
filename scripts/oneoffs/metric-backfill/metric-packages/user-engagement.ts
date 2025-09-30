import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type UserEngagementRow = {
  userId: number;
  targetUserId: number;
  type: string;
  createdAt: Date;
};

export const userEngagementPackage: MigrationPackage<UserEngagementRow> = {
  queryBatchSize: 5000,
  range: createIdRangeFetcher('UserEngagement', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<UserEngagementRow>(
      `SELECT "userId", "targetUserId", "type", "createdAt"
       FROM "UserEngagement"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
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
