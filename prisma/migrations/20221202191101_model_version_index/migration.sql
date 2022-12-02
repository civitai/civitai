-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "index" INTEGER;

WITH current_index AS (
    SELECT
        id,
        row_number() OVER (PARTITION BY "modelId" ORDER BY "createdAt" DESC, "id" DESC) "index"
    FROM "ModelVersion"
)
UPDATE "ModelVersion" mv SET index=ci.index
FROM current_index ci
WHERE ci.id = mv.id