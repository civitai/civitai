import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type CollectionContributorRow = {
  collectionId: number;
  userId: number;
  createdAt: Date;
};

export const collectionContributorPackage: MigrationPackage<CollectionContributorRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('CollectionContributor', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CollectionContributorRow>(
      `SELECT "collectionId", "userId", "createdAt"
       FROM "CollectionContributor"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((contributor) => {
      addMetrics(
        {
          entityType: 'Collection',
          entityId: contributor.collectionId,
          userId: contributor.userId,
          metricType: 'followerCount',
          metricValue: 1,
          createdAt: contributor.createdAt,
        },
        {
          entityType: 'Collection',
          entityId: contributor.collectionId,
          userId: contributor.userId,
          metricType: 'contributorCount',
          metricValue: 1,
          createdAt: contributor.createdAt,
        }
      );
    });
  },
};
