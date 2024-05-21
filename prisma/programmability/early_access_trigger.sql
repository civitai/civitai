CREATE OR REPLACE FUNCTION early_access_ends_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."earlyAccessEndsAt" = COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_early_access_ends_at
BEFORE UPDATE OF "earlyAccessConfig" ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION early_access_ends_at();
