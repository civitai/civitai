CREATE OR REPLACE FUNCTION early_access_ends_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."publishedAt" IS NOT NULL AND NEW."earlyAccessConfig" IS NOT NULL THEN
        IF NEW."earlyAccessConfig"->>'timeframe' IS NOT NULL
            AND NEW."earlyAccessConfig"->>'timeframe' > 0 THEN
                UPDATE "ModelVersion" 
                SET "earlyAccessEndsAt" = COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval,
                    "availability" = 'EarlyAccess'
                WHERE id = NEW.id;  
        ELSE IF NEW."earlyAccessConfig"->>'timeframe' = 0 THEN
            UPDATE "ModelVersion"
            SET "earlyAccessEndsAt" = NOW(),
                "availability" = 'Public'
            WHERE id = NEW.id;
        END IF;
    ELSE
    	UPDATE "ModelVersion"
		SET "earlyAccessEndsAt" = NULL,
    		"availability" = 'Public'
    	WHERE id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_early_access_ends_at
AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION early_access_ends_at();
