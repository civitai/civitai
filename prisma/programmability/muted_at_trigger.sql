CREATE OR REPLACE FUNCTION update_muted_at()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if muted is set to true and update mutedAt to now()
    IF NEW.muted THEN
        NEW."mutedAt" := now();
    -- Check if muted is set to false and clear mutedAt
    ELSIF NOT NEW.muted THEN
        NEW."mutedAt" := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_update_muted_at
BEFORE UPDATE OF muted ON "User"
FOR EACH ROW
EXECUTE FUNCTION update_muted_at();
