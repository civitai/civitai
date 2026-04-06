CREATE OR REPLACE FUNCTION update_muted_at()
RETURNS TRIGGER AS $$
BEGIN
    -- Clear mutedAt when muted is set to false
    IF NOT NEW.muted THEN
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
