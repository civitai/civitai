-- DonationGoal polymorphism (phase 1, EXPAND). Mirrors PaidAccess: attach a donation goal to any
-- gated entity via (entityType, entityId) instead of the ModelVersion-only FK. Additive and
-- backward-compatible — modelVersionId stays dual-written and is dropped (with the trigger) in phase 2.
-- Applied manually (we do NOT use prisma migrate deploy).
--
-- DEPLOY ORDER: apply BEFORE the phase-1 code deploys. Code still running at that point writes only
-- modelVersionId; the transition trigger below derives entityType/entityId so nothing is missed.

ALTER TABLE "DonationGoal" ADD COLUMN "entityType" "PaidAccessEntityType";
ALTER TABLE "DonationGoal" ADD COLUMN "entityId"   INTEGER;

-- Backfill existing rows from the FK.
UPDATE "DonationGoal"
SET "entityType" = 'ModelVersion', "entityId" = "modelVersionId"
WHERE "modelVersionId" IS NOT NULL AND "entityId" IS NULL;

CREATE INDEX "DonationGoal_entityType_entityId_idx" ON "DonationGoal" ("entityType", "entityId");

-- Transition trigger: an insert/update from not-yet-updated code writes only modelVersionId, so
-- derive entityType/entityId from it (no-op once the code writes them directly). Dropped in phase 2.
CREATE OR REPLACE FUNCTION donation_goal_fill_entity() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."entityId" IS NULL AND NEW."modelVersionId" IS NOT NULL THEN
        NEW."entityType" := 'ModelVersion';
        NEW."entityId"   := NEW."modelVersionId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER donation_goal_fill_entity_trigger
BEFORE INSERT OR UPDATE OF "modelVersionId" ON "DonationGoal"
FOR EACH ROW EXECUTE FUNCTION donation_goal_fill_entity();
