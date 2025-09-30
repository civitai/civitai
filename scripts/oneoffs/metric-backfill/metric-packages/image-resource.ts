import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type ImageResourceRow = {
  modelId: number;
  modelVersionId: number;
  imageUserId: number;
  imageCreatedAt: Date;
};

export const imageResourcePackage: MigrationPackage<ImageResourceRow> = {
  queryBatchSize: 5000,
  range: createIdRangeFetcher('ImageResourceNew', `EXISTS (SELECT 1 FROM "Image" i WHERE i.id = "ImageResourceNew"."imageId" AND i."createdAt" < '${CUTOFF_DATE}')`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<ImageResourceRow>(
      `SELECT mv."modelId", ir."modelVersionId",
              i."userId" as "imageUserId", i."createdAt" as "imageCreatedAt"
       FROM "ImageResourceNew" ir
       JOIN "Image" i ON i.id = ir."imageId"
       JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
       WHERE i."createdAt" < $1
         AND ir.id >= $2
         AND ir.id <= $3
       ORDER BY ir.id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((resource) => {
      addMetrics(
        // Model imageCount
        {
          entityType: 'Model',
          entityId: resource.modelId,
          userId: resource.imageUserId,
          metricType: 'imageCount',
          metricValue: 1,
          createdAt: resource.imageCreatedAt,
        },
        // ModelVersion imageCount
        {
          entityType: 'ModelVersion',
          entityId: resource.modelVersionId,
          userId: resource.imageUserId,
          metricType: 'imageCount',
          metricValue: 1,
          createdAt: resource.imageCreatedAt,
        }
      );
    });
  },
};
