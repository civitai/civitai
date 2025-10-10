import type { BatchRange, MigrationPackage, QueryContext } from '../types';
import { CUTOFF_DATE, START_DATE } from '../utils';

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
    const result = await pg.query<{ minId: number, maxId: number }>(`
      SELECT
        (SELECT id FROM "Image" WHERE "createdAt" >= $1 ORDER BY "createdAt" ASC LIMIT 1) as "minId",
        (SELECT id FROM "Image" WHERE "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT 1) as "maxId"
    `, [START_DATE, CUTOFF_DATE]);
    const minId = result[0]?.minId || 0;
    const maxId = result[0]?.maxId || 0;
    return { start: minId, end: maxId };
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
