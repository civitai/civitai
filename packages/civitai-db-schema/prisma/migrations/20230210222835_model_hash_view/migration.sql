-- Rename Table
ALTER TABLE
  "ModelHash" RENAME TO "ModelFileHash";

-- AlterTable
ALTER TABLE
  "ModelFileHash" RENAME CONSTRAINT "ModelHash_pkey" TO "ModelFileHash_pkey";

-- RenameForeignKey
ALTER TABLE
  "ModelFileHash" RENAME CONSTRAINT "ModelHash_fileId_fkey" TO "ModelFileHash_fileId_fkey";

-- Add View
CREATE
OR REPLACE VIEW "ModelHash" AS
SELECT
  m.id "modelId",
  mv.id "modelVersionId",
  mh.type "hashType",
  mh.hash
FROM
  "Model" m
  JOIN "ModelVersion" mv ON mv."modelId" = m.id
  JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
  JOIN "ModelFileHash" mh ON mh."fileId" = mf.id
WHERE
  mf.type = 'Model'