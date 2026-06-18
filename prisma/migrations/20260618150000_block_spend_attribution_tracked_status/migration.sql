-- ============================================================
-- App Blocks — buzz SPEND attribution: TRACK-ONLY status retrofit
-- ============================================================
-- Widen block_spend_attribution.status to include the 'tracked' state and
-- make it the new default, so the spend flow uses the SAME track-only write
-- model as block_subscription_attribution (#2629). See
-- src/server/services/blocks/buzz-attribution.service.ts:recordSpendAttribution.
--
-- WHY: recordSpendAttribution no longer applies the spend rate card at write
-- time. It records the EVENT + the MONEY BASIS (gross_value_cents) only and
-- writes the row 'tracked' with app_owner_share_cents=0, spend_share_pct=0,
-- rate_card_version='unrated'. The author bounty is computed LATER, at PAYOUT
-- time, as a retroactive BACKPAY over status='tracked' rows at the signed-off
-- spendSharePct (computeSpendShare stays in rate-card.ts for that). This
-- avoids baking the placeholder 5% into immutable rows before monetization
-- sign-off, and makes the spend ledger consistent with the membership ledger
-- (the backpay reader processes status='tracked' rows).
--
-- PURELY ADDITIVE: this only WIDENS the status IN-list (adds 'tracked') and
-- changes the column DEFAULT from 'pending' to 'tracked'. Every previously
-- valid status remains valid, so existing rows stay valid with no backfill.
-- Prod currently has 0 spend rows (the spend flow has not shipped); any
-- pre-existing 'pending' rows would also remain valid under the new CHECK.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule #8): committed for history, NOT
--    auto-applied. A human must run this via psql/retool BEFORE the code that
--    writes 'tracked' spend rows deploys, on:
--      1. prod nvme0  (role=postgres CNPG cluster — the main civitai DB)
--      2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)

ALTER TABLE "block_spend_attribution"
  DROP CONSTRAINT "block_spend_attribution_status_check",
  ADD CONSTRAINT "block_spend_attribution_status_check"
    CHECK ("status" IN ('tracked', 'pending', 'confirmed', 'voided', 'paid_out', 'held'));

ALTER TABLE "block_spend_attribution"
  ALTER COLUMN "status" SET DEFAULT 'tracked';
