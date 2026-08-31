-- ============================================================
-- App Blocks — buzz SPEND attribution + author bounty (W3 flow A)
-- ============================================================
-- One row per block-initiated generation that SPENDS the viewer's own
-- Buzz balance. Drives the publisher (app author) revenue-share payout
-- pipeline for the *spend* flow. See claudedocs/
-- app-blocks-attribution-backhalf-scope-2026-06-18.md (section A) for the
-- end-to-end design.
--
-- WHY A NEW TABLE (not block_buzz_attribution):
-- A spend is NOT a card purchase. It is the viewer burning their OWN
-- existing Buzz balance on a generation — there is no payment provider,
-- no provider fee, no Stripe/Paddle transaction, and no refund/chargeback
-- /clawback lifecycle. block_buzz_attribution is purchase-shaped: its
-- conservation CHECK (provider_fee + platform_share + app_owner_share =
-- usd_amount) assumes a card transaction whose gross is divided three
-- ways. Spend attribution has a DIFFERENT accounting model (see below),
-- so hosting it in the purchase table would mean relaxing that CHECK and
-- polluting the purchase aggregates (getRevenueForOwner). A dedicated
-- table keeps each flow's lifecycle and invariants clean.
--
-- ACCOUNTING MODEL — PLATFORM-FUNDED BOUNTY (not a cut of the spend):
-- The viewer's Buzz spend on the generation is final and untouched — the
-- orchestrator already debited the viewer's balance and 100% of that
-- spend is the platform's revenue (the viewer paid civitai for compute).
-- The author's share is a SEPARATE, PLATFORM-FUNDED bounty paid ON TOP
-- of the spend, sized as a percentage of the spend's USD value. It is a
-- platform marketing/ecosystem expense, NOT a slice carved out of the
-- viewer's money. Implication: there is NO three-way conservation
-- invariant here (unlike purchase). The only invariants are:
--   - author_share_cents >= 0
--   - author_share_cents = floor(gross_value_cents * spend_share_pct/100)
--   - author_share_cents = 0 on self-spend or internal-owner.
-- gross_value_cents is recorded for audit/reporting (the USD value of the
-- Buzz burned, at buzzDollarRatio 1000 Buzz = $1 = 100 cents) but it is
-- the platform's revenue, not a pool being split.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule #8): committed for history, NOT
--    auto-applied. A human must run this via psql/retool BEFORE the code
--    that writes spend rows deploys, on:
--      1. prod nvme0  (role=postgres CNPG cluster — the main civitai DB)
--      2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)
--
-- app_owner_user_id is denormalized at attribution time so payouts are
-- stable even if OauthClient.userId is later reassigned (mirrors
-- block_buzz_attribution).

CREATE TABLE "block_spend_attribution" (
  -- Application-generated ULID: 'bsa_<ulid>' (30 chars).
  "id"                      TEXT PRIMARY KEY,

  -- Spend facts: the viewer burned `buzz_amount` Buzz on this generation.
  -- gross_value_cents is its USD value (buzzDollarRatio 1000:1 -> cents),
  -- recorded for reporting. This is platform revenue, NOT a split pool.
  "user_id"                 INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "buzz_amount"             INTEGER NOT NULL,
  "buzz_type"               TEXT NOT NULL DEFAULT 'yellow',
  "gross_value_cents"       INTEGER NOT NULL,

  -- Generation link. workflow_id is the orchestrator's id for the
  -- submitted generation; it is the idempotency anchor (a re-poll / retry
  -- / re-submit of the SAME workflow must not double-attribute).
  "workflow_id"             TEXT NOT NULL,

  -- Attribution context (all derived server-side from the verified block
  -- token claims — never client-supplied, so inherently forge-safe).
  "app_id"                  TEXT NOT NULL REFERENCES "OauthClient"("id") ON DELETE RESTRICT,
  "app_block_id"            TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE RESTRICT,
  "block_instance_id"       TEXT NOT NULL,
  -- Optional: model the generation ran against. Pure analytics.
  "model_id"                INTEGER,

  -- Author bounty (computed at attribution time against the active spend
  -- rate card). Denormalized rate_card_version so the row pays out under
  -- its stamped snapshot forever (mirrors block_buzz_attribution).
  "rate_card_version"       TEXT NOT NULL,
  "spend_share_pct"         INTEGER NOT NULL,
  "app_owner_share_cents"   INTEGER NOT NULL,
  -- Denormalized publisher user — snapshot at attribution time.
  "app_owner_user_id"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,

  -- Lifecycle. Mirrors block_buzz_attribution's status machine so the
  -- payout aggregator can treat both flows uniformly. Spend has no refund
  -- path, so 'voided' here is only ever self-spend/internal-owner (a
  -- zero-share audit row), never a refund/chargeback.
  "status"                  TEXT NOT NULL DEFAULT 'pending',
  "voided_reason"           TEXT,
  "attributed_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmed_at"            TIMESTAMPTZ,
  "voided_at"               TIMESTAMPTZ,
  "paid_out_at"             TIMESTAMPTZ,
  "payout_id"               TEXT,

  -- IDEMPOTENCY: one spend attribution per (workflow, app block). A
  -- re-poll / retry / re-submit of the same workflow hits this UNIQUE and
  -- is a no-op (P2002 caught + treated as already-written). app_block_id
  -- is part of the key (rather than workflow_id alone) to mirror the
  -- purchase table and leave room for a future multi-block split without
  -- a schema change.
  CONSTRAINT "block_spend_attribution_workflow_app_uniq"
    UNIQUE ("workflow_id", "app_block_id"),

  CONSTRAINT "block_spend_attribution_status_check"
    CHECK ("status" IN ('pending', 'confirmed', 'voided', 'paid_out', 'held')),
  CONSTRAINT "block_spend_attribution_voided_reason_check"
    CHECK (
      "voided_reason" IS NULL OR "voided_reason" IN (
        'self_spend', 'internal_owner', 'manual_review'
      )
    ),
  -- Non-negativity. There is NO three-way conservation CHECK here: the
  -- author share is a platform-funded bounty, NOT a slice of
  -- gross_value_cents (see the accounting-model note above). The author
  -- share is independently bounded to its rate-card percentage by the
  -- service (computeSpendShare) and re-derivable from
  -- gross_value_cents * spend_share_pct / 100.
  CONSTRAINT "block_spend_attribution_amounts_nonneg_check"
    CHECK (
      "buzz_amount" >= 0 AND
      "gross_value_cents" >= 0 AND
      "spend_share_pct" >= 0 AND
      "app_owner_share_cents" >= 0
    ),
  -- The author bounty can never exceed the spend's gross USD value — a
  -- defensive ceiling that catches a runaway rate / arithmetic bug at
  -- write time (a bounty larger than the revenue it rewards is always a
  -- bug, even though the bounty is platform-funded).
  CONSTRAINT "block_spend_attribution_share_le_gross_check"
    CHECK ("app_owner_share_cents" <= "gross_value_cents"),
  -- Bound the TEXT primary key length. 'bsa_' (4) + 26 Crockford base32
  -- chars = 30 total.
  CONSTRAINT "block_spend_attribution_id_length_check"
    CHECK (char_length("id") BETWEEN 28 AND 40)
);

-- Publisher dashboard: "show me my spend-bounty revenue across all apps".
CREATE INDEX "bsa_publisher_dashboard_idx"
  ON "block_spend_attribution" ("app_owner_user_id", "attributed_at" DESC);

-- Per-app drilldown.
CREATE INDEX "bsa_app_block_dashboard_idx"
  ON "block_spend_attribution" ("app_block_id", "attributed_at" DESC);

-- Payout job: scan only confirmed-unpaid rows ordered by confirm time.
CREATE INDEX "bsa_payout_idx"
  ON "block_spend_attribution" ("status", "confirmed_at")
  WHERE "status" = 'confirmed';

-- Confirm-pending cron: scan only pending rows ordered by attribution time.
CREATE INDEX "bsa_pending_aging_idx"
  ON "block_spend_attribution" ("status", "attributed_at")
  WHERE "status" = 'pending';
