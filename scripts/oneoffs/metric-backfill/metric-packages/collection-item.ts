import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type CollectionItemRow = {
  collectionId: number;
  articleId: number | null;
  postId: number | null;
  imageId: number | null;
  modelId: number | null;
  addedById: number;
  createdAt: Date;
};

export const collectionItemPackage: MigrationPackage<CollectionItemRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('CollectionItem', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CollectionItemRow>(
      `SELECT "collectionId", "articleId", "postId", "imageId", "modelId",
              "addedById", "createdAt"
       FROM "CollectionItem"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
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
      if (item.modelId) {
        addMetrics({
          entityType: 'Model',
          entityId: item.modelId,
          userId: item.addedById,
          metricType: 'collectedCount',
          metricValue: 1,
          createdAt: item.createdAt,
        });
      }

      if (item.postId) {
        addMetrics({
          entityType: 'Post',
          entityId: item.postId,
          userId: item.addedById,
          metricType: 'collectedCount',
          metricValue: 1,
          createdAt: item.createdAt,
        });
      }

      if (item.articleId) {
        addMetrics({
          entityType: 'Article',
          entityId: item.articleId,
          userId: item.addedById,
          metricType: 'collectedCount',
          metricValue: 1,
          createdAt: item.createdAt,
        });
      }

      if (item.imageId) {
        addMetrics({
          entityType: 'Image',
          entityId: item.imageId,
          userId: item.addedById,
          metricType: 'Collection',
          metricValue: 1,
          createdAt: item.createdAt,
        });
      }
    });
  },
};
