-- Record the 'tracked' status default and widened CHECK that production and dev already have.
--
-- HISTORY BACKFILL — already applied by hand in prod and dev. Verified on the prod replica:
-- the column default is 'tracked' and the CHECK list includes it. This migration exists so a
-- database provisioned from prisma/migrations matches them.
--
-- Without it, the committed history still declares DEFAULT 'pending' and a CHECK list that omits
-- 'tracked' (20260618130000_block_spend_attribution, lines 86 and 103-104), so a fresh local, CI or
-- new-environment database rejects EVERY spend-attribution insert with SQLSTATE 23514 — the writer
-- at buzz-attribution.service.ts sends status: 'tracked' explicitly.
--
-- 'pending' stays in the CHECK list: the partial index bsa_pending_aging_idx is built on it for a
-- contemplated confirm-pending cron, and dropping it from the list is a separate decision.
--
-- Written idempotently so applying it to an environment that already has the hand-applied state is
-- a no-op. Table is small (68 rows in prod); the CHECK revalidation is not a concern.

ALTER TABLE "block_spend_attribution"
  ALTER COLUMN "status" SET DEFAULT 'tracked';

ALTER TABLE "block_spend_attribution"
  DROP CONSTRAINT IF EXISTS "block_spend_attribution_status_check";

ALTER TABLE "block_spend_attribution"
  ADD CONSTRAINT "block_spend_attribution_status_check"
    CHECK ("status" IN ('tracked', 'pending', 'confirmed', 'voided', 'paid_out', 'held'));
