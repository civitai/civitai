CREATE OR REPLACE FUNCTION early_access_ends_at()
RETURNS TRIGGER AS $$
DECLARE
    -- Text comparison instead of a ::boolean cast, so a malformed value (only reachable via raw SQL — the tRPC
    -- write path is zod-validated) can never raise and abort the enclosing publish/update transaction.
    is_permanent boolean := COALESCE(
        NEW."earlyAccessConfig" IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'permanent') = 'true',
        false
    );
BEGIN
    IF is_permanent THEN
        -- Permanent paid access (highest precedence): gated indefinitely. The column is tracked even before
        -- publish, so a Creator-Program member can configure permanent access on an unpublished version and have
        -- it counted/known immediately. Once published, keep "earlyAccessEndsAt" NULL (the auto-expiry job filters
        -- "earlyAccessEndsAt" <= NOW(), so NULL excludes it) and "availability" = 'EarlyAccess' so every paywall
        -- still gates it.
        IF NEW."publishedAt" IS NOT NULL THEN
            UPDATE "ModelVersion"
            SET "earlyAccessEndsAt" = NULL,
                "availability" = 'EarlyAccess',
                "earlyAccessPermanent" = true
            WHERE id = NEW.id;
        ELSE
            UPDATE "ModelVersion"
            SET "earlyAccessPermanent" = true
            WHERE id = NEW.id
              AND "earlyAccessPermanent" IS DISTINCT FROM true;
        END IF;
    ELSIF NEW."publishedAt" IS NOT NULL
        AND NEW."earlyAccessConfig" IS NOT NULL
        -- Ensure the user has paid for early access
        AND NEW."earlyAccessConfig"->>'timeframe' IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'timeframe')::int > 0
    THEN
        UPDATE "ModelVersion"
        SET "earlyAccessEndsAt" = COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval,
            "availability" = 'EarlyAccess',
            "earlyAccessPermanent" = false
        WHERE id = NEW.id;
    ELSE
        IF NEW."publishedAt" IS NOT NULL THEN
            UPDATE "ModelVersion"
            SET "earlyAccessEndsAt" = NULL,
                "availability" = 'Public',
                "earlyAccessPermanent" = false
            WHERE id = NEW.id;
        ELSE
            -- Unpublished + not permanent: only clear a previously-set permanent flag (e.g. permanent -> off
            -- before publish); otherwise leave the row untouched, matching the original no-op behavior.
            UPDATE "ModelVersion"
            SET "earlyAccessPermanent" = false
            WHERE id = NEW.id
              AND "earlyAccessPermanent" IS DISTINCT FROM false;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_early_access_ends_at
AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION early_access_ends_at();
