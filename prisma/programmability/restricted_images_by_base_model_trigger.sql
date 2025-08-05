-- Trigger on ImageResourceNew changes
CREATE OR REPLACE FUNCTION refresh_restricted_images_on_resource_change()
RETURNS TRIGGER AS $$
DECLARE
    affected_count INTEGER;
    restricted_models TEXT[] := ARRAY['SDXL Turbo', 'SVD', 'Stable Cascade', 'SD 3', 'SD 3.5', 'Sd 3.5 Medium', 'SD 3.5 Large', 'SD 3.5 Large Turbo'];
BEGIN
    -- Check if any of the affected model versions have restricted base models
    IF TG_OP = 'INSERT' THEN
        SELECT COUNT(*)
        INTO affected_count
        FROM "ModelVersion" mv
        WHERE mv.id = NEW."modelVersionId"
          AND mv."baseModel" = ANY(restricted_models);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT COUNT(*)
        INTO affected_count
        FROM "ModelVersion" mv
        WHERE mv.id = OLD."modelVersionId"
          AND mv."baseModel" = ANY(restricted_models);
    END IF;

    -- Only refresh if we found restricted model versions
    IF affected_count > 0 THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER refresh_restricted_images_resource
    AFTER INSERT OR DELETE ON "ImageResourceNew"
    FOR EACH ROW
    EXECUTE FUNCTION refresh_restricted_images_on_resource_change();

-- Trigger on ModelVersion baseModel changes
CREATE OR REPLACE FUNCTION refresh_restricted_images_on_version_change()
RETURNS TRIGGER AS $$
DECLARE
    restricted_models TEXT[] := ARRAY['SDXL Turbo', 'SVD', 'Stable Cascade', 'SD 3', 'SD 3.5', 'Sd 3.5 Medium', 'SD 3.5 Large', 'SD 3.5 Large Turbo'];
BEGIN
    -- Check if baseModel changed and involves restricted models
    IF TG_OP = 'UPDATE' AND OLD."baseModel" IS DISTINCT FROM NEW."baseModel" THEN
        -- Refresh if old or new baseModel is in restricted list
        IF OLD."baseModel" = ANY(restricted_models) OR NEW."baseModel" = ANY(restricted_models) THEN
            REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
        END IF;
    ELSIF TG_OP = 'INSERT' AND NEW."baseModel" = ANY(restricted_models) THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    ELSIF TG_OP = 'DELETE' AND OLD."baseModel" = ANY(restricted_models) THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER refresh_restricted_images_version
    AFTER INSERT OR UPDATE OR DELETE ON "ModelVersion"
    FOR EACH ROW
    EXECUTE FUNCTION refresh_restricted_images_on_version_change();
