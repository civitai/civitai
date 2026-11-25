import { Prisma } from '@prisma/client';

/**
 * imageResourcesCache's lookup: each image's resources with their version and model. Rows are
 * ordered by the table's primary key (image, then model version) because that order is the cached
 * order, which decides `modelVersionIds` and the first Checkpoint's `baseModel`. feed-go's copy
 * (apps/feed-go/internal/hydrate/resources.go, sqlImageResources) must order the same way, pinned
 * by src/server/redis/__tests__/image-resources.sql.behavior.test.ts.
 */
export function imageResourcesQuery(imageIds: number[]) {
  return Prisma.sql`
    SELECT
      ir."imageId",
      ir."modelVersionId",
      ir.strength,
      ir.detected,
      m.id as "modelId",
      m.name as "modelName",
      m.type as "modelType",
      mv.name as "versionName",
      mv."baseModel",
      m.poi,
      m.minor
    FROM "ImageResourceNew" ir
    JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
    JOIN "Model" m ON mv."modelId" = m.id
    WHERE ir."imageId" IN (${Prisma.join(imageIds)})
    ORDER BY ir."imageId", ir."modelVersionId"
  `;
}
