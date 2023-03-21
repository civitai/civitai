-- AlterTable
ALTER TABLE
  "Model"
ALTER COLUMN
  "name"
SET
  DATA TYPE CITEXT;

-- AlterTable
drop view "ModelHash";

ALTER TABLE
  "ModelFileHash"
ALTER COLUMN
  "hash"
SET
  DATA TYPE CITEXT;

create view "ModelHash"(
  "modelId",
  "modelVersionId",
  "fileType",
  "hashType",
  hash
) as
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  mf.type AS "fileType",
  mh.type AS "hashType",
  mh.hash
FROM
  "Model" m
  JOIN "ModelVersion" mv ON mv."modelId" = m.id
  JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
  JOIN "ModelFileHash" mh ON mh."fileId" = mf.id
WHERE
  mf.type = ANY (ARRAY ['Model'::text, 'Pruned Model'::text]);

-- AlterTable
ALTER TABLE
  "Question"
ALTER COLUMN
  "title"
SET
  DATA TYPE CITEXT;

-- AlterTable
ALTER TABLE
  "Tag"
ALTER COLUMN
  "name"
SET
  DATA TYPE CITEXT;

-- CreateIndex
CREATE INDEX "Account_provider_userId_idx" ON "Account"("provider", "userId");

-- CreateIndex
CREATE INDEX "Model_name_idx" ON "Model"("name" text_pattern_ops);

-- CreateIndex
CREATE INDEX "Model_status_nsfw_idx" ON "Model"("status", "nsfw");

-- CreateIndex
CREATE INDEX "ModelFileHash_hash_idx" ON "ModelFileHash" USING HASH ("hash");

-- CreateIndex
CREATE INDEX "UserActivity_createdAt_idx" ON "UserActivity"("createdAt");