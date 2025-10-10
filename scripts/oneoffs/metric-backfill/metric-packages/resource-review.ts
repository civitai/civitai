import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createFilteredIdRangeFetcher } from './base';

type ResourceReviewRow = {
  modelId: number | null;
  modelVersionId: number | null;
  userId: number;
  recommended: boolean | null;
  createdAt: Date;
};

export const resourceReviewPackage: MigrationPackage<ResourceReviewRow> = {
  queryBatchSize: 2000,
  range: createFilteredIdRangeFetcher('ResourceReview', 'createdAt', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),
  query: async ({ pg }, { start, end }) => {
    return pg.query<ResourceReviewRow>(
      `SELECT "modelId", "modelVersionId", "userId", "recommended", "createdAt"
       FROM "ResourceReview"
       WHERE id >= $1
         AND id <= $2
       ORDER BY id`,
      [start, end]
    );
  },
  processor: ({ rows, addMetrics }) => {
    rows.forEach((review) => {
      // Model metrics
      if (review.modelId) {
        addMetrics({
          entityType: 'Model',
          entityId: review.modelId,
          userId: review.userId,
          metricType: 'ratingCount',
          metricValue: 1,
          createdAt: review.createdAt,
        });

        if (review.recommended !== null) {
          addMetrics({
            entityType: 'Model',
            entityId: review.modelId,
            userId: review.userId,
            metricType: review.recommended ? 'thumbsUpCount' : 'thumbsDownCount',
            metricValue: 1,
            createdAt: review.createdAt,
          });
        }
      }

      // ModelVersion metrics
      if (review.modelVersionId) {
        addMetrics({
          entityType: 'ModelVersion',
          entityId: review.modelVersionId,
          userId: review.userId,
          metricType: 'ratingCount',
          metricValue: 1,
          createdAt: review.createdAt,
        });

        if (review.recommended !== null) {
          addMetrics({
            entityType: 'ModelVersion',
            entityId: review.modelVersionId,
            userId: review.userId,
            metricType: review.recommended ? 'thumbsUpCount' : 'thumbsDownCount',
            metricValue: 1,
            createdAt: review.createdAt,
          });
        }
      }
    });
  },
};
