import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createColumnRangeFetcher } from './base';

enum CollectionContributorPermission {
  VIEW = 'VIEW',
  ADD = 'ADD',
  ADD_REVIEW = 'ADD_REVIEW',
  MANAGE = 'MANAGE'
}

type CollectionContributorRow = {
  collectionId: number;
  userId: number;
  createdAt: Date;
  permissions: CollectionContributorPermission[];
};

export const collectionContributorPackage: MigrationPackage<CollectionContributorRow> = {
  queryBatchSize: 2000,
  range: createColumnRangeFetcher('CollectionContributor', 'collectionId', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CollectionContributorRow>(
      `SELECT "collectionId", cc."userId", cc."createdAt", permissions
       FROM "CollectionContributor" cc
       JOIN "Collection" c ON c.id = cc."collectionId"
       WHERE cc."createdAt" < $1
         AND "collectionId" >= $2
         AND "collectionId" <= $3
         AND c."mode" != 'Bookmark'
       ORDER BY "collectionId"`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    for (const row of rows) {
      addMetrics({
        entityType: 'Collection',
        entityId: row.collectionId,
        userId: row.userId,
        metricType: 'followerCount',
        metricValue: 1,
        createdAt: row.createdAt,
      })

      if (typeof row.permissions === 'string') {
        row.permissions = (row.permissions as string).slice(1, -1).split(',') as CollectionContributorPermission[]
      }
      const isContributor = row.permissions.some((p) => p !== CollectionContributorPermission.VIEW);
      if (isContributor) {
        addMetrics({
          entityType: 'Collection',
          entityId: row.collectionId,
          userId: row.userId,
          metricType: 'contributorCount',
          metricValue: 1,
          createdAt: row.createdAt,
        });
      }
    }
  },
};
