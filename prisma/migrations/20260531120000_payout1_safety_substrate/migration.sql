-- ============================================================
-- PAYOUT-1 safety substrate for App Blocks revenue attribution
-- ============================================================
-- Makes the block_buzz_attribution financial state machine safe to
-- switch on WITHOUT building real money disbursement (leadership-gated).
-- Three pieces:
--
--   1. Velocity/volume HOLD gate. New status='held' + hold_reason/held_at
--      columns let the confirm-pending cron park high-velocity owners for
--      manual review instead of blindly ripening them to 'confirmed'.
--
--   2. Idempotent payout minting. New block_attribution_payout ledger
--      table with UNIQUE(app_owner_user_id, period_key) — a publisher is
--      paid at most once per period. mintPayoutForOwner inserts here in
--      the same transaction it flips rows to paid_out.
--
--   3. Refund-after-payout clawback. New entry_type column. A clawback
--      row carries NEGATIVE app_owner_share_cents / usd_amount_cents and
--      status='confirmed' so the payout aggregator nets it out of the
--      publisher's next period. This required relaxing the original
--      non-negativity CHECK (see below) — the conservation CHECK still
--      holds because 0 + 0 + (-X) = -X.
--
-- DO NOT mistake any of this for disbursement: no money moves here. The
-- block_attribution_payout row records that the ledger was minted, not
-- that cash was sent.

BEGIN;

-- ------------------------------------------------------------
-- 1 + 3. New columns on block_buzz_attribution.
-- ------------------------------------------------------------
ALTER TABLE "block_buzz_attribution"
  ADD COLUMN "hold_reason" TEXT,
  ADD COLUMN "held_at"     TIMESTAMPTZ,
  ADD COLUMN "entry_type"  TEXT NOT NULL DEFAULT 'purchase';

-- Allow the new lifecycle state 'held' (confirm-pending parks
-- high-velocity owners here for manual review).
ALTER TABLE "block_buzz_attribution"
  DROP CONSTRAINT "block_buzz_attribution_status_check";
ALTER TABLE "block_buzz_attribution"
  ADD CONSTRAINT "block_buzz_attribution_status_check"
    CHECK ("status" IN ('pending', 'confirmed', 'voided', 'paid_out', 'held'));

-- entry_type allowlist.
ALTER TABLE "block_buzz_attribution"
  ADD CONSTRAINT "block_buzz_attribution_entry_type_check"
    CHECK ("entry_type" IN ('purchase', 'clawback'));

-- Relax the original blanket non-negativity CHECK. Clawback rows MUST be
-- able to carry negative app_owner_share_cents / usd_amount_cents (the
-- carry-forward debt). We keep non-negativity for everything else by
-- scoping the old guard to entry_type='purchase', and add a mirror-image
-- guard for clawback rows so they can ONLY be non-positive (never a
-- "negative purchase" or a "positive clawback" by accident).
ALTER TABLE "block_buzz_attribution"
  DROP CONSTRAINT "block_buzz_attribution_amounts_nonneg_check";
ALTER TABLE "block_buzz_attribution"
  ADD CONSTRAINT "block_buzz_attribution_purchase_amounts_nonneg_check"
    CHECK (
      "entry_type" <> 'purchase' OR (
        "buzz_amount" >= 0 AND
        "usd_amount_cents" >= 0 AND
        "app_owner_share_cents" >= 0 AND
        "platform_share_cents" >= 0 AND
        "provider_fee_cents" >= 0
      )
    );
ALTER TABLE "block_buzz_attribution"
  ADD CONSTRAINT "block_buzz_attribution_clawback_amounts_nonpos_check"
    CHECK (
      "entry_type" <> 'clawback' OR (
        "usd_amount_cents" <= 0 AND
        "app_owner_share_cents" <= 0 AND
        "platform_share_cents" = 0 AND
        "provider_fee_cents" = 0
      )
    );

-- The conservation CHECK
-- (provider_fee + platform_share + app_owner_share = usd_amount) is
-- UNCHANGED — it already holds for clawback rows: 0 + 0 + (-X) = -X.

-- Index for the confirm-pending sweep's per-owner grouping over aging
-- pending rows (it groups candidate rows by app_owner_user_id). The
-- existing bba_pending_aging_idx covers the (status, attributed_at)
-- filter; this one helps the GROUP BY app_owner_user_id over the parked
-- 'held' rows the ops review queue scans.
CREATE INDEX "bba_held_review_idx"
  ON "block_buzz_attribution" ("app_owner_user_id", "held_at")
  WHERE "status" = 'held';

-- ------------------------------------------------------------
-- 2. block_attribution_payout idempotency ledger.
-- ------------------------------------------------------------
-- One row per (app_owner_user_id, period_key). The UNIQUE is the
-- no-double-pay guard: a racing or retried mint hits it and no-ops.
-- This records that a payout was MINTED for a period; it does NOT mean
-- money moved. Disbursement is a separate, leadership-gated step.
CREATE TABLE "block_attribution_payout" (
  -- Application-generated id: 'bba_payout_<ulid>'.
  "id"                 TEXT PRIMARY KEY,
  "app_owner_user_id"  INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  -- Caller-supplied period bucket, e.g. ISO week '2026-W22'.
  "period_key"         TEXT NOT NULL,
  -- Net publisher share minted (after clawbacks net out). Always > 0 —
  -- mintPayoutForOwner refuses to mint a non-positive net (the debt
  -- carries forward as un-flipped confirmed rows instead).
  "total_cents"        INTEGER NOT NULL,
  -- Number of block_buzz_attribution rows flipped to paid_out.
  "row_count"          INTEGER NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "block_attribution_payout_owner_period_uniq"
    UNIQUE ("app_owner_user_id", "period_key"),
  CONSTRAINT "block_attribution_payout_total_positive_check"
    CHECK ("total_cents" > 0),
  CONSTRAINT "block_attribution_payout_row_count_nonneg_check"
    CHECK ("row_count" >= 0),
  CONSTRAINT "block_attribution_payout_id_length_check"
    CHECK (char_length("id") BETWEEN 35 AND 48)
);

-- Publisher payout history lookup (newest first).
CREATE INDEX "bap_owner_created_idx"
  ON "block_attribution_payout" ("app_owner_user_id", "created_at" DESC);

COMMIT;
