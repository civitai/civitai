ALTER TYPE "HomeBlockType" ADD VALUE 'FeaturedModelVersion';

DROP MATERIALIZED VIEW IF EXISTS "CoveredCheckpointDetails";

/*
 For history:

create materialized view "CoveredCheckpointDetails" as
WITH
    newest AS (
        SELECT
            mv_1."modelId",
            min(mv_1.index) AS index
        FROM "ModelVersion" mv_1
        WHERE
            mv_1."baseModel" = ANY
            (ARRAY ['SD 1.5'::text, 'SD 1.4'::text, 'SD 1.5 LCM'::text, 'SDXL 0.9'::text, 'SDXL 1.0'::text, 'SDXL 1.0 LCM'::text, 'Pony'::text, 'Illustrious'::text, 'SD 3.5'::text, 'SD 3.5 Medium'::text, 'SD 3.5 Large'::text, 'SD 3.5 Large Turbo'::text])
        GROUP BY mv_1."modelId"
    )
SELECT
    mv.id   AS version_id,
    m.name  AS model,
    mv.name AS version,
    CASE
        WHEN cc.version_id IS NULL THEN 'latest only'::text
        ELSE 'specific version'::text
        END AS type,
    mv."baseModel"
FROM "CoveredCheckpoint" cc
     JOIN "Model" m ON m.id = cc.model_id
     JOIN newest n ON n."modelId" = cc.model_id
     JOIN "ModelVersion" mv ON cc.version_id = mv.id OR
                               cc.version_id IS NULL AND mv."modelId" = cc.model_id AND mv.index = n.index AND mv.status = 'Published'::"ModelStatus";
 */
