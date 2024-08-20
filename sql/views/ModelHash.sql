 SELECT m.id AS "modelId",
    mv.id AS "modelVersionId",
    mf.type AS "fileType",
    mh.type AS "hashType",
    mh.hash
   FROM ((("Model" m
     JOIN "ModelVersion" mv ON ((mv."modelId" = m.id)))
     JOIN "ModelFile" mf ON ((mf."modelVersionId" = mv.id)))
     JOIN "ModelFileHash" mh ON ((mh."fileId" = mf.id)))
  WHERE (mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text]));