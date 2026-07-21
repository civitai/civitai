-- Permanent pay-for-access (CU 868ke4949).
--
-- SAFE TO RUN BEFORE THE CODE DEPLOY: purely additive. The new column defaults false, and the rewritten
-- trigger only takes its new "permanent" branch when a version's earlyAccessConfig carries a `permanent`
-- flag — which no existing row has and only the (not-yet-deployed) new code writes. So for every current
-- row the trigger behaves exactly as before, and the running (old) code simply ignores the new column.

-- 1. Additive column. NULL-safe: default false = no behavior change for existing rows.
ALTER TABLE "ModelVersion"
  ADD COLUMN IF NOT EXISTS "earlyAccessPermanent" boolean NOT NULL DEFAULT false;

-- 2. Rewrite the early-access trigger with a highest-precedence "permanent" branch. A permanent version
--    keeps earlyAccessEndsAt NULL (so the auto-expiry job — which filters earlyAccessEndsAt <= NOW() —
--    never touches it) but stays availability = 'EarlyAccess' so every paywall still gates it. The
--    "earlyAccessPermanent" column is derived here from the config flag (tracked even before publish, so a
--    member can configure permanent access on an unpublished version). Behavior for non-permanent rows is
--    unchanged. Permanent detection uses a text comparison (not ::boolean) so a malformed value can't abort
--    the transaction.
CREATE OR REPLACE FUNCTION early_access_ends_at()
RETURNS TRIGGER AS $$
DECLARE
    is_permanent boolean := COALESCE(
        NEW."earlyAccessConfig" IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'permanent') = 'true',
        false
    );
BEGIN
    IF is_permanent THEN
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
            -- Unpublished + not permanent: only clear a previously-set permanent flag; otherwise no-op.
            UPDATE "ModelVersion"
            SET "earlyAccessPermanent" = false
            WHERE id = NEW.id
              AND "earlyAccessPermanent" IS DISTINCT FROM false;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_early_access_ends_at
AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION early_access_ends_at();
