-- Trigger on ImageResourceNew changes
CREATE OR REPLACE FUNCTION refresh_restricted_images_on_resource_change()
RETURNS TRIGGER AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY "RestrictedImagesByBaseModel";
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER refresh_restricted_images_resource
    AFTER INSERT OR DELETE ON "ImageResourceNew"
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_restricted_images_on_resource_change();
