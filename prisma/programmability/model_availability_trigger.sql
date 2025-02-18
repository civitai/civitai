CREATE OR REPLACE FUNCTION update_version_availability()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.availability = 'Private'::"Availability" THEN
        UPDATE "ModelVersion" SET availability = 'Private'::"Availability" WHERE "modelId" = NEW.id;
    ELSIF NOT availability = 'Public'::"Availability" THEN
        UPDATE "ModelVersion" SET availability = 'Public'::"Availability" WHERE "modelId" = NEW.id AND availability != 'EarlyAccess'::"Availability";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_update_version_availability
BEFORE UPDATE OF availability ON "Model"
FOR EACH ROW
EXECUTE FUNCTION update_version_availability();
