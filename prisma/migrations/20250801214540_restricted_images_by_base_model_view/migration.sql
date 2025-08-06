-- Create table to store restricted base models
CREATE TABLE IF NOT EXISTS "RestrictedBaseModels" (
    "baseModel" TEXT NOT NULL PRIMARY KEY
);

-- Insert the restricted base models
INSERT INTO "RestrictedBaseModels" ("baseModel") VALUES
    ('SDXL Turbo'),
    ('SVD'),
    ('Stable Cascade'),
    ('SD 3'),
    ('SD 3.5'),
    ('SD 3.5 Medium'),
    ('SD 3.5 Large'),
    ('SD 3.5 Large Turbo')
ON CONFLICT DO NOTHING;

-- Create materialized view using the new table
CREATE MATERIALIZED VIEW "RestrictedImagesByBaseModel" AS
SELECT DISTINCT irn."imageId"
FROM "ImageResourceNew" irn
JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
JOIN "RestrictedBaseModels" rbm ON rbm."baseModel" = mv."baseModel"
WITH DATA;

CREATE UNIQUE INDEX CONCURRENTLY idx_restricted_images_by_base_model_imageid 
ON "RestrictedImagesByBaseModel" ("imageId");
