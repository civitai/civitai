-- Outbox Triggers for Entity Event Tracking

-- Model Triggers
-- DELETED trigger (when DeletedAt is set)
CREATE OR REPLACE FUNCTION outbox_model_deleted_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('DELETED', 'Model', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_model_deleted_on_update
AFTER UPDATE ON "Model"
FOR EACH ROW
EXECUTE FUNCTION outbox_model_deleted_trigger();

-- Model DELETE trigger (when actually deleted)
CREATE OR REPLACE FUNCTION outbox_model_deleted_on_delete_trigger()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "Outbox" (event, "entityType", "entityId")
    VALUES ('DELETED', 'Model', OLD.id);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_model_deleted_on_delete
AFTER DELETE ON "Model"
FOR EACH ROW
EXECUTE FUNCTION outbox_model_deleted_on_delete_trigger();

-- PUBLISHED/UNPUBLISHED trigger for Model (based on status column)
CREATE OR REPLACE FUNCTION outbox_model_publish_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- Published: status changed to 'Published' from any other status
    IF OLD.status != 'Published' AND NEW.status = 'Published' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('PUBLISHED', 'Model', NEW.id);
    -- Unpublished: status changed from 'Published' to any other status
    ELSIF OLD.status = 'Published' AND NEW.status != 'Published' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('UNPUBLISHED', 'Model', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_model_publish_status
AFTER UPDATE ON "Model"
FOR EACH ROW
EXECUTE FUNCTION outbox_model_publish_trigger();

-- ModelVersion Triggers
-- PUBLISHED/UNPUBLISHED trigger (based on status column)
CREATE OR REPLACE FUNCTION outbox_model_version_publish_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- Published: status changed to 'Published' from any other status
    IF OLD.status != 'Published' AND NEW.status = 'Published' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('PUBLISHED', 'ModelVersion', NEW.id);
    -- Unpublished: status changed from 'Published' to any other status
    ELSIF OLD.status = 'Published' AND NEW.status != 'Published' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('UNPUBLISHED', 'ModelVersion', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_model_version_publish_status
AFTER UPDATE ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION outbox_model_version_publish_trigger();

-- Post Triggers
-- PUBLISHED/UNPUBLISHED trigger
CREATE OR REPLACE FUNCTION outbox_post_publish_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- Published: publishedAt set from null
    IF OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('PUBLISHED', 'Post', NEW.id);
    -- Unpublished: publishedAt set to null from not null
    ELSIF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS NULL THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('UNPUBLISHED', 'Post', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_post_publish_status
AFTER UPDATE ON "Post"
FOR EACH ROW
EXECUTE FUNCTION outbox_post_publish_trigger();

-- DELETED trigger for Post
CREATE OR REPLACE FUNCTION outbox_post_deleted_trigger()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "Outbox" (event, "entityType", "entityId")
    VALUES ('DELETED', 'Post', OLD.id);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_post_deleted_on_delete
AFTER DELETE ON "Post"
FOR EACH ROW
EXECUTE FUNCTION outbox_post_deleted_trigger();

-- Image Triggers
-- COVER_CHANGE trigger (when index is set to 1 from something else and postId is not null)
CREATE OR REPLACE FUNCTION outbox_image_cover_change_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."postId" IS NOT NULL AND NEW.index = 1 AND OLD.index != 1 THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('UPDATED', 'Post', NEW."postId");
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_image_cover_change
AFTER UPDATE ON "Image"
FOR EACH ROW
EXECUTE FUNCTION outbox_image_cover_change_trigger();

-- TO_SCAN trigger (when image is created with ingestionStatus='Pending' or updated to 'Rescan')
CREATE OR REPLACE FUNCTION outbox_image_to_scan_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- On INSERT: check if ingestionStatus is 'Pending'
    IF TG_OP = 'INSERT' AND NEW.ingestion = 'Pending' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('TO_SCAN', 'Image', NEW.id);
    -- On UPDATE: check if ingestionStatus changed to 'Rescan' from any other status
    ELSIF TG_OP = 'UPDATE' AND OLD.ingestion != 'Rescan' AND NEW.ingestion = 'Rescan' THEN
        INSERT INTO "Outbox" (event, "entityType", "entityId")
        VALUES ('TO_SCAN', 'Image', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_image_to_scan
AFTER INSERT OR UPDATE ON "Image"
FOR EACH ROW
EXECUTE FUNCTION outbox_image_to_scan_trigger();