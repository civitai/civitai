-- Trigger on ImageResourceNew changes
CREATE OR REPLACE FUNCTION refresh_restricted_images_on_resource_change()
RETURNS TRIGGER AS $$
DECLARE
    model_version_id INTEGER;
    is_restricted BOOLEAN := FALSE;
BEGIN
    -- Get the modelVersionId based on operation
    IF TG_OP = 'INSERT' THEN
        model_version_id := NEW."modelVersionId";
    ELSIF TG_OP = 'DELETE' THEN
        model_version_id := OLD."modelVersionId";
    ELSE
        -- Should not happen, but defensive programming
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Skip if no model version ID
    IF model_version_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if the model version has a restricted base model
    SELECT EXISTS (
        SELECT 1 
        FROM "ModelVersion" mv
        JOIN "RestrictedBaseModels" rbm ON rbm."baseModel" = mv."baseModel"
        WHERE mv.id = model_version_id
    ) INTO is_restricted;

    -- Refresh materialized view if needed
    IF is_restricted THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    END IF;

    RETURN COALESCE(NEW, OLD);
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
    should_refresh BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'INSERT' AND NEW."baseModel" IS NOT NULL THEN
        -- Check if new baseModel is restricted
        should_refresh := EXISTS (SELECT 1 FROM "RestrictedBaseModels" WHERE "baseModel" = NEW."baseModel");
    ELSIF TG_OP = 'DELETE' AND OLD."baseModel" IS NOT NULL THEN
        -- Check if deleted baseModel was restricted
        should_refresh := EXISTS (SELECT 1 FROM "RestrictedBaseModels" WHERE "baseModel" = OLD."baseModel");
    ELSIF TG_OP = 'UPDATE' THEN
        -- Only refresh if baseModel actually changed and either old or new is restricted
        IF OLD."baseModel" IS DISTINCT FROM NEW."baseModel" THEN
            IF NEW."baseModel" IS NOT NULL THEN
                should_refresh := EXISTS (SELECT 1 FROM "RestrictedBaseModels" WHERE "baseModel" = NEW."baseModel");
            END IF;
            
            IF NOT should_refresh AND OLD."baseModel" IS NOT NULL THEN
                should_refresh := EXISTS (SELECT 1 FROM "RestrictedBaseModels" WHERE "baseModel" = OLD."baseModel");
            END IF;
        END IF;
    END IF;

    -- Refresh materialized view if needed
    IF should_refresh THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER refresh_restricted_images_version
    AFTER INSERT OR UPDATE OF "baseModel" OR DELETE ON "ModelVersion"
    FOR EACH ROW
    EXECUTE FUNCTION refresh_restricted_images_on_version_change();

-- Trigger on RestrictedBaseModels changes
CREATE OR REPLACE FUNCTION refresh_restricted_images_on_restricted_models_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Always refresh when restricted base models are added, updated, or removed
    REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER refresh_restricted_images_restricted_models
    AFTER INSERT OR UPDATE OR DELETE ON "RestrictedBaseModels"
    FOR EACH ROW
    EXECUTE FUNCTION refresh_restricted_images_on_restricted_models_change();
