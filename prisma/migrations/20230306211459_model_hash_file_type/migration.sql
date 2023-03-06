-- Add View
DROP VIEW IF EXISTS "ModelHash";
CREATE VIEW "ModelHash" AS
SELECT
  m.id "modelId",
  mv.id "modelVersionId",
  mf.type "fileType",
  mh.type "hashType",
  mh.hash
FROM
  "Model" m
  JOIN "ModelVersion" mv ON mv."modelId" = m.id
  JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
  JOIN "ModelFileHash" mh ON mh."fileId" = mf.id
WHERE
  mf.type IN ('Model', 'Pruned Model');