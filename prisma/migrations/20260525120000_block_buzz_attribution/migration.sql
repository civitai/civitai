-- ============================================================
-- App Blocks — buzz purchase attribution + revenue share
-- ============================================================
-- One row per buzz purchase that originated inside an App Block. Drives
-- the publisher revenue-share payout pipeline. See claudedocs/
-- app-blocks-buzz-attribution-handoff-2026-05-25.md for the end-to-end
-- design and the rate-card discussion.
--
-- block_instance_id is intentionally TEXT NOT NULL (not an FK) because
-- the install context for an attribution can be any of:
--   - real model_block_installs row  -> 'mbi_*'
--   - publisher subscription         -> 'bus_pub_*'  (synthetic)
--   - viewer subscription            -> 'bus_view_*' (synthetic)
--   - platform default               -> 'pdb_*'      (synthetic)
-- The scope column tells the reader which surface the id resolves
-- against — see BlockRegistry.resolveBlockInstance.
--
-- app_owner_user_id is denormalized at attribution time so payouts are
-- stable even if OauthClient.userId is later reassigned (rare, but the
-- spec says past attributions pay out under the snapshot they were
-- stamped with — see rate_card_version for the same logic on shares).
--
-- payout_id is TEXT (no FK) until the canonical creator-payout batch
-- model is identified — see the open question in the handoff. Switch
-- to an FK when that lands.

CREATE TABLE "block_buzz_attribution" (
  -- Application-generated ULID: 'bba_<ulid>' (30 chars).
  "id"                      TEXT PRIMARY KEY,

  -- Purchase facts
  "user_id"                 INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "buzz_amount"             INTEGER NOT NULL,
  "usd_amount_cents"        INTEGER NOT NULL,
  "buzz_type"               TEXT NOT NULL DEFAULT 'yellow',

  -- Payment provider link
  "payment_provider"        TEXT NOT NULL,
  "payment_transaction_id"  TEXT NOT NULL,
  -- BuzzTransaction lives in the buzz API, not Postgres, so this is a
  -- free-form text reference to the buzz-side transactionId. Nullable
  -- because the attribution write happens after the buzz API call and
  -- we keep the row for audit even if the buzz call failed and we
  -- later re-resolve the txId via the provider's idempotency path.
  "buzz_transaction_id"     TEXT,

  -- Attribution context
  "app_id"                  TEXT NOT NULL REFERENCES "OauthClient"("id") ON DELETE RESTRICT,
  "app_block_id"            TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE RESTRICT,
  "block_instance_id"       TEXT NOT NULL,
  "scope"                   TEXT NOT NULL,
  -- Optional: model the user was browsing when the purchase fired. Pure
  -- analytics — not load-bearing for revenue calc.
  "model_id"                INTEGER,

  -- Revenue share (computed at attribution time against ACTIVE_RATE_CARD)
  "rate_card_version"       TEXT NOT NULL,
  "app_owner_share_cents"   INTEGER NOT NULL,
  "platform_share_cents"    INTEGER NOT NULL,
  "provider_fee_cents"      INTEGER NOT NULL,
  -- Denormalized publisher user — snapshot at attribution time, not a
  -- live join through OauthClient.userId. See comment block above.
  "app_owner_user_id"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,

  -- Lifecycle
  "status"                  TEXT NOT NULL DEFAULT 'pending',
  "voided_reason"           TEXT,
  "attributed_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmed_at"            TIMESTAMPTZ,
  "voided_at"               TIMESTAMPTZ,
  "paid_out_at"             TIMESTAMPTZ,
  "payout_id"               TEXT,

  -- One attribution per (purchase, app). Supports a future multi-app
  -- split without a schema change — today the modal is owned by exactly
  -- one block context, so we only ever write one row per purchase.
  CONSTRAINT "block_buzz_attribution_payment_app_uniq"
    UNIQUE ("payment_transaction_id", "app_block_id"),

  CONSTRAINT "block_buzz_attribution_scope_check"
    CHECK ("scope" IN (
      'per_model_install',
      'publisher_all_my_models',
      'viewer_personal',
      'platform_default'
    )),
  CONSTRAINT "block_buzz_attribution_status_check"
    CHECK ("status" IN ('pending', 'confirmed', 'voided', 'paid_out')),
  CONSTRAINT "block_buzz_attribution_voided_reason_check"
    CHECK (
      "voided_reason" IS NULL OR "voided_reason" IN (
        'refund', 'chargeback', 'self_purchase', 'manual_review'
      )
    ),
  CONSTRAINT "block_buzz_attribution_provider_check"
    CHECK ("payment_provider" IN ('stripe', 'paddle', 'nowpayments')),
  CONSTRAINT "block_buzz_attribution_amounts_nonneg_check"
    CHECK (
      "buzz_amount" >= 0 AND
      "usd_amount_cents" >= 0 AND
      "app_owner_share_cents" >= 0 AND
      "platform_share_cents" >= 0 AND
      "provider_fee_cents" >= 0
    ),
  -- Conservation check: provider fee + platform share + publisher share
  -- equals gross. Catches arithmetic bugs in the rate-card calculator at
  -- write time rather than at reconciliation time.
  CONSTRAINT "block_buzz_attribution_share_sum_check"
    CHECK (
      "provider_fee_cents" + "platform_share_cents" + "app_owner_share_cents"
      = "usd_amount_cents"
    ),
  -- Bound the TEXT primary key length. 'bba_' (4) + 26 Crockford base32
  -- chars = 30 total.
  CONSTRAINT "block_buzz_attribution_id_length_check"
    CHECK (char_length("id") BETWEEN 28 AND 40)
);

-- Publisher dashboard: "show me my recent revenue across all my apps".
CREATE INDEX "bba_publisher_dashboard_idx"
  ON "block_buzz_attribution" ("app_owner_user_id", "attributed_at" DESC);

-- Per-app drilldown: "show me revenue for this specific app block".
CREATE INDEX "bba_app_block_dashboard_idx"
  ON "block_buzz_attribution" ("app_block_id", "attributed_at" DESC);

-- Payout job: scan only confirmed-unpaid rows ordered by confirm time.
-- Partial index keeps it tiny — paid_out rows fall out of the index.
CREATE INDEX "bba_payout_idx"
  ON "block_buzz_attribution" ("status", "confirmed_at")
  WHERE "status" = 'confirmed';

-- Confirm-pending cron: scan only pending rows ordered by attribution
-- time. Partial index again keeps lookups cheap — once a row leaves
-- 'pending' it falls out of the index.
CREATE INDEX "bba_pending_aging_idx"
  ON "block_buzz_attribution" ("status", "attributed_at")
  WHERE "status" = 'pending';

-- Refund webhook lookup: void by (provider, payment_transaction_id).
-- Not unique on its own (multi-app split would reuse the same payment_
-- transaction_id with different app_block_ids), so a regular index.
CREATE INDEX "bba_payment_tx_idx"
  ON "block_buzz_attribution" ("payment_provider", "payment_transaction_id");
