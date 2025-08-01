CREATE MATERIALIZED VIEW "RestrictedImagesByBaseModel" AS
SELECT DISTINCT irn."imageId"
FROM "ImageResourceNew" irn
JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId" 
WHERE mv."baseModel" IN ('SDXL Turbo', 'SVD', 'Stable Cascade', 'SD 3', 'SD 3.5', 'Sd 3.5 Medium', 'SD 3.5 Large', 'SD 3.5 Large Turbo')
WITH DATA;

CREATE INDEX CONCURRENTLY idx_restricted_images_by_base_model_imageid 
ON "RestrictedImagesByBaseModel" ("imageId");
