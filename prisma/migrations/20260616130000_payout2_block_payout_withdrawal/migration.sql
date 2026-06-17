-- ============================================================
-- PAYOUT-2 — block_payout_withdrawal tracking table
-- ============================================================
-- Tracking record for the App Blocks publisher revenue-share DISBURSEMENT
-- (the "separate rail" pull-model withdrawal added in PR1). One row per
-- `withdrawAppRevenue` attempt.
--
-- This is the App-Blocks analogue of "CashWithdrawal", kept on its OWN table
-- so app-revenue payouts are NEVER conflated with creator-program cash
-- withdrawals. The disbursement nets confirmed `block_buzz_attribution` share
-- and pays it via Tipalti WITHOUT ever touching the externally-owned Buzz cash
-- accounts (cashSettled/cashPending) or the creator-program pool — that
-- separation is the whole point of the separate rail (avoids the pool cap +
-- 30% fee; preserves the Tipalti 1099-NEC path).
--
-- MANUAL APPLY ONLY: per the datapacket-talos repo rule, App-Blocks / civitai
-- migrations are NOT auto-applied by CI/deploy. A human applies this SQL to
-- each environment (prod nvme0 + the dev clone). `_prisma_migrations` is not
-- the source of truth here.
--
-- DARK: this table is only written by `withdrawAppRevenue`, which refuses
-- unless the `app-blocks-payout-enabled` Flipt flag is on (defaults closed).
-- Creating the table moves no money and changes no behaviour on its own.

BEGIN;

CREATE TABLE "block_payout_withdrawal" (
  -- Application-generated id: 'bpw_<ulid>'. The Tipalti refCode (ref_code) is
  -- derived from it (prefix 'BPW' + the ULID tail, 16 chars).
  "id"                 TEXT PRIMARY KEY,
  "app_owner_user_id"  INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  -- Links to the block_attribution_payout ledger row this disbursement
  -- realized. ON DELETE SET NULL so a compensating revert (which deletes the
  -- ledger row) does not also delete the audit record of the failed attempt.
  "payout_id"          TEXT REFERENCES "block_attribution_payout"("id") ON DELETE SET NULL,
  -- Net publisher share disbursed, in USD cents (matches the minted ledger
  -- row's total_cents). Tipalti is paid cents/100.
  "amount_cents"       INTEGER NOT NULL,
  -- Tipalti CashWithdrawalMethod snapshot.
  "method"             TEXT NOT NULL,
  -- App-Blocks-rail Tipalti refCode (prefix 'BPW', 16 chars, derived from id).
  -- The full refCode is stored + indexed so the webhook reconciles by exact
  -- match (the refCode is NOT round-trippable into the id — Tipalti 16-char cap).
  "ref_code"           TEXT NOT NULL,
  -- The refCode Tipalti echoes back on the created payment batch. Persisted so
  -- reconciliation can match either what we sent or what Tipalti returned.
  "payment_ref_code"   TEXT,
  -- State machine (see schema.full.prisma for the full doc):
  --   'processing'       — row created; mint/Tipalti in progress.
  --   'pending_approval' — Tipalti batch created, awaiting mod approval.
  --   'completed'        — payment approved/completed (terminal, money sent).
  --   'failed'           — disbursement/mint failed OR Tipalti declined; mint
  --                        reverted + balance restored (terminal).
  --   'no_balance'       — nothing to disburse at mint time (terminal, no money).
  "status"             TEXT NOT NULL DEFAULT 'processing',
  "payment_batch_id"   TEXT,
  "note"               TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- amount_cents starts at 0 ('processing' before the mint claims rows) and is
  -- set to the minted total on disburse, so the floor is >= 0 (not > 0).
  CONSTRAINT "block_payout_withdrawal_amount_nonneg_check"
    CHECK ("amount_cents" >= 0),
  CONSTRAINT "block_payout_withdrawal_status_check"
    CHECK ("status" IN ('processing', 'pending_approval', 'completed', 'failed', 'no_balance')),
  CONSTRAINT "block_payout_withdrawal_id_length_check"
    CHECK (char_length("id") BETWEEN 20 AND 48)
);

-- Publisher withdrawal history lookup (newest first).
CREATE INDEX "bpw_owner_created_idx"
  ON "block_payout_withdrawal" ("app_owner_user_id", "created_at" DESC);

-- Find the withdrawal that realized a given payout ledger row.
CREATE INDEX "bpw_payout_idx"
  ON "block_payout_withdrawal" ("payout_id");

-- Webhook reconciliation: look up the row by the Tipalti refCode (exact match).
CREATE INDEX "bpw_ref_code_idx"
  ON "block_payout_withdrawal" ("ref_code");

COMMIT;
