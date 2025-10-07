import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createFilteredIdRangeFetcher } from './base';

type CollectionItemRow = {
  collectionId: number;
  entityId: number;
  entityType: 'Model' | 'Post' | 'Article' | 'Image';
  addedById: number;
  createdAt: Date;
};

export const collectionItemPackage: MigrationPackage<CollectionItemRow> = {
  queryBatchSize: 10000,
  range: createFilteredIdRangeFetcher('CollectionItem', 'createdAt', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CollectionItemRow>(
      `SELECT "collectionId",
              COALESCE("modelId", "postId", "articleId", "imageId") as "entityId",
              CASE
                WHEN "modelId" IS NOT NULL THEN 'Model'
                WHEN "postId" IS NOT NULL THEN 'Post'
                WHEN "articleId" IS NOT NULL THEN 'Article'
                WHEN "imageId" IS NOT NULL THEN 'Image'
              END as "entityType",
              "addedById", "createdAt"
       FROM "CollectionItem"
       WHERE id >= $1
         AND id <= $2`,
      [start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((item) => {
      // Collection itemCount metric
      addMetrics({
        entityType: 'Collection',
        entityId: item.collectionId,
        userId: item.addedById,
        metricType: 'itemCount',
        metricValue: 1,
        createdAt: item.createdAt,
      });

      // Entity-specific collectedCount metrics
      if (item.entityId && item.entityType) {
        if (item.entityType === 'Image') {
          addMetrics({
            entityType: item.entityType,
            entityId: item.entityId,
            userId: item.addedById,
            metricType: 'Collection',
            metricValue: 1,
            createdAt: item.createdAt,
          });
        } else {
          addMetrics({
            entityType: item.entityType,
            entityId: item.entityId,
            userId: item.addedById,
            metricType: 'collectedCount',
            metricValue: 1,
            createdAt: item.createdAt,
          });
        }
      }
    });
  },
};
