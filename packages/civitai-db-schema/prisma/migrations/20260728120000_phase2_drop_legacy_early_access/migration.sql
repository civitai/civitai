-- Phase 2 (model-only; ComicChapter stays on the legacy path until stage 5): drop the now-dead legacy
-- early-access columns and the ModelVersion trigger that maintained them. Early-access state is derived
-- live from PaidAccess everywhere (feed/shop filters EXISTS over PaidAccess; the Meili index projects the
-- deadline from PaidAccess at sync time). Nothing reads these columns anymore.
--
-- Apply MANUALLY (we do not use prisma migrate deploy). Idempotent via IF EXISTS. Order matters: drop the
-- ModelVersion trigger/function BEFORE the columns it references. Does NOT touch ComicChapter's own
-- earlyAccessConfig/earlyAccessEndsAt or its trigger.
--
-- NOTE: the DonationGoal (entityType, entityId) re-key — dropping modelVersionId + FK + the
-- donation_goal_fill_entity trigger and re-keying Donation — is deliberately NOT here; it needs a data
-- cleanup of orphan/duplicate goals first and lands in its own migration.

-- Model: model-level early-access is derived from PaidAccess, not this denormalized column.
ALTER TABLE "Model" DROP COLUMN IF EXISTS "earlyAccessDeadline";

-- DonationGoal dead columns: paidAmount (never written — the donated total is summed from Donation) and
-- isEarlyAccess (EA-ness derived live from the entity's PaidAccess record, not a stored flag).
ALTER TABLE "DonationGoal"
  DROP COLUMN IF EXISTS "paidAmount",
  DROP COLUMN IF EXISTS "isEarlyAccess";

-- ModelVersion legacy early-access. The trigger's only remaining effect was pushing availability on
-- publish, but the native write path sets availability='Public' itself (publishModelVersionsWithEarlyAccess)
-- and the column defaults to Public — so dropping the trigger does not change publish behavior.
DROP TRIGGER IF EXISTS trigger_early_access_ends_at ON "ModelVersion";
DROP FUNCTION IF EXISTS early_access_ends_at();

ALTER TABLE "ModelVersion"
  DROP COLUMN IF EXISTS "earlyAccessConfig",
  DROP COLUMN IF EXISTS "earlyAccessEndsAt",
  DROP COLUMN IF EXISTS "earlyAccessPermanent";
