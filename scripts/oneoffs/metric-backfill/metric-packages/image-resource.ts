import type { MigrationPackage, EntityMetricEvent, QueryContext, BatchRange } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createColumnRangeFetcher, createIdRangeFetcher } from './base';

type ImageResourceRow = {
  modelId: number;
  modelVersionId: number;
  imageUserId: number;
  imageCreatedAt: Date;
};

export const imageResourcePackage: MigrationPackage<ImageResourceRow> = {
  queryBatchSize: 5000,
  range: async (ctx: QueryContext): Promise<BatchRange> => {
    const { pg } = ctx;
    const lastImageId = await pg.query<{ id: number }>(`
      SELECT id
      FROM "Image"
      WHERE "createdAt" < $1
      ORDER BY "createdAt" DESC
      LIMIT 1
    `, [CUTOFF_DATE]);
    return createColumnRangeFetcher('ImageResourceNew', 'imageId', `"imageId" <= ${lastImageId[0]?.id || 0}`)(ctx);
  },

  query: async ({ pg }, { start, end }) => {
    return pg.query<ImageResourceRow>(
      `SELECT
          mv."modelId",
          ir."modelVersionId",
          i."userId" as "imageUserId",
          i."createdAt" as "imageCreatedAt"
       FROM "ImageResourceNew" ir
       JOIN "Image" i ON i.id = ir."imageId"
       JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
       WHERE ir."imageId" >= $1
         AND ir."imageId" <= $2`,
      [start, end]
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
