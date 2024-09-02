ALTER TABLE "ModelVersion" ADD COLUMN "uploadType" "ModelUploadType" NOT NULL DEFAULT 'Created';

UPDATE "ModelVersion" mv
SET "uploadType" = m."uploadType"
FROM "Model" m
WHERE m.id = mv."modelId";

-- rerun the above after push
