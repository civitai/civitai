import { Prisma } from '@prisma/client';

/**
 * imageResourcesCache's lookup: each image's resources with their version and model, ordered by
 * image then model version (the table's primary key), so every miss computes the same order.
 * Without the ORDER BY the order was whatever the plan returned, and it differed between databases
 * and plans: the cached order decides `modelVersionIds`, and the first Checkpoint decides an image's
 * `baseModel`. feed-go's copy (apps/feed-go/internal/hydrate/resources.go, sqlImageResources) orders
 * the same way; src/server/redis/__tests__/image-resources.sql.behavior.test.ts pins the two.
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
