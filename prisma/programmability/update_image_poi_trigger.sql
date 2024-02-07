CREATE OR REPLACE FUNCTION update_image_poi()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.poi THEN
        -- If poi is true, mark related images for review
        UPDATE "Image" i SET "needsReview" = 'poi'
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ir."imageId" = i.id AND m.id = NEW.id AND i."needsReview" IS NULL
          AND i.nsfw != 'None'::"NsfwLevel"; -- Assuming 'None' is a valid value in "NsfwLevel" enum
    ELSE
        -- If poi is false, remove the review mark if no other POI models are associated
        UPDATE "Image" i SET "needsReview" = null
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ir."imageId" = i.id AND m.id = NEW.id AND i."needsReview" = 'poi'
          AND NOT EXISTS (
              SELECT 1
              FROM "ImageResource" irr
              JOIN "ModelVersion" mvv ON mvv.id = irr."modelVersionId"
              JOIN "Model" mm ON mm.id = mvv."modelId"
              WHERE mm.poi AND mm.id != NEW.id AND irr."imageId" = i.id
          );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER model_poi_change
AFTER UPDATE OF poi ON "Model"
FOR EACH ROW
WHEN (OLD.poi IS DISTINCT FROM NEW.poi)
EXECUTE FUNCTION update_image_poi();
