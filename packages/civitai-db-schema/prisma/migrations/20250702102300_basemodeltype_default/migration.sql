ALTER TABLE "ModelVersion" ALTER COLUMN "baseModelType" SET DEFAULT 'Standard';

UPDATE "ModelVersion"
SET "baseModelType" = 'Standard'
WHERE "baseModelType" IS NULL;

ALTER TABLE "ModelVersion" ALTER COLUMN "baseModelType" SET NOT NULL;
