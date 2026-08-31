-- ============================================================
-- App Blocks — MEMBERSHIP / subscription attribution (W3 flow C)
-- ============================================================
-- One row PER PAID INVOICE per app block: a block-initiated membership
-- (recurring subscription) purchase credits the app author a revenue
-- share on each paid invoice. See claudedocs/
-- app-blocks-attribution-backhalf-scope-2026-06-18.md (section C) for the
-- end-to-end design. This is the recurring-revenue sibling of
-- block_buzz_attribution (one-shot card purchase) and
-- block_spend_attribution (internal Buzz burn).
--
-- WHY A NEW TABLE (not block_buzz_attribution):
-- A subscription has a recurring lifecycle the one-shot purchase table
-- never modelled:
--   - ONE invoice per billing period (subscription_create on first
--     purchase, subscription_cycle on every renewal). The natural
--     idempotency anchor is the per-period `invoice_id`, NOT a single
--     payment_transaction_id.
--   - `subscription_id` groups the periods so we can reconcile / report
--     across a subscription's life.
--   - cancellation / proration introduce events the buzz table never had
--     (subscription.deleted / .updated). Conflating recurring + one-shot
--     in one table would pollute getRevenueForOwner's purchase aggregates
--     and force the purchase table's CHECKs to flex for a different shape.
-- A dedicated table keeps each flow's lifecycle and invariants clean
-- while reusing the same status machine + clawback pattern.
--
-- ⚠️ TRACK-ONLY WRITE MODEL (#2629). The webhook write records the
-- ATTRIBUTION EVENT + the MONEY BASIS (gross_value_cents + provider_fee_cents)
-- only. It does NOT apply the rate card at write time. Tracked rows are
-- written:
--   status               = 'tracked'   (share-pending, not yet computed)
--   app_owner_share_cents = 0
--   subscription_share_pct= 0
--   rate_card_version     = 'unrated'  (no version stamped)
--   platform_share_cents  = gross - fee (net)
-- The author share is computed LATER, at PAYOUT time (Slice 4): the payout
-- rail reads status='tracked' rows and applies the SIGNED-OFF
-- subscriptionSharePct as a clean retroactive BACKPAY
-- (author_share = net × rate), then transitions them to a computed state.
-- This avoids baking a placeholder rate into immutable rows before
-- monetization sign-off.
--
-- ACCOUNTING MODEL — same three-way split as block_buzz_attribution (the
-- backpay applies it; the tracked row pre-stages it):
-- A membership payment IS a real card transaction (gross USD, real
-- provider fee). The author share is carved out of the NET (gross - fee)
-- per the rate card's subscription percentage, the platform keeps the
-- remainder. The three-way conservation invariant DOES hold even in the
-- TRACK-ONLY state because author=0 and platform=net:
--   provider_fee_cents + platform_share_cents + app_owner_share_cents
--     = fee + net + 0 = gross_value_cents
-- The backpay later re-splits net into platform/author at the signed-off
-- rate (still conserving the sum).
-- Clawback rows (entry_type='clawback') carry NEGATIVE shares and net out
-- in the payout aggregate, so the CHECK is scoped to entry_type='charge'.
-- (Track-only writes never produce a clawback — a refunded tracked row is
-- simply voided before any backpay runs, since author=0 means no debt.)
--
-- RENEWALS-PAY POLICY (⚠️ FLAGGED — monetization sign-off, scope §C/E#3):
-- This table writes ONE row per PAID invoice — so by default a renewal
-- (subscription_cycle) accrues an author share just like the initial
-- purchase (subscription_create). This is the "renewals pay" policy. If
-- product decides "first-invoice-only", the SERVICE gates the write to
-- billing_reason='subscription_create' (no schema change needed) — the
-- `billing_reason` column below records which it was so the policy is
-- auditable + reversible after the fact.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule #8): committed for history, NOT
--    auto-applied. A human must run this via psql/retool BEFORE the code
--    that writes subscription rows deploys, on:
--      1. prod nvme0  (role=postgres CNPG cluster — the main civitai DB)
--      2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)
--
-- app_owner_user_id is denormalized at attribution time so payouts are
-- stable even if OauthClient.userId is later reassigned (mirrors
-- block_buzz_attribution).

CREATE TABLE "block_subscription_attribution" (
  -- Application-generated ULID: 'bsu_<ulid>' (30 chars).
  "id"                      TEXT PRIMARY KEY,

  -- Purchase facts. user_id is the subscriber (purchaser). buzz_amount is
  -- the membership's monthly Buzz bonus for this invoice (analytics only —
  -- the share is computed off usd/gross, not Buzz).
  "user_id"                 INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "buzz_amount"             INTEGER NOT NULL DEFAULT 0,
  "buzz_type"               TEXT NOT NULL DEFAULT 'yellow',
  -- Gross USD value of the invoice, in cents (Stripe invoice amount_paid).
  "gross_value_cents"       INTEGER NOT NULL,

  -- Subscription / invoice link. invoice_id is the per-period idempotency
  -- anchor (each renewal = a new invoice_id = at most one row).
  -- subscription_id groups the periods. billing_reason records WHY this
  -- invoice fired (subscription_create | subscription_cycle |
  -- subscription_update) so the renewals-pay vs first-only policy is
  -- auditable. payment_provider lets a future Paddle leg share the table.
  "payment_provider"        TEXT NOT NULL,
  "invoice_id"              TEXT NOT NULL,
  "subscription_id"         TEXT,
  "billing_reason"          TEXT,
  -- Period window for reporting (from the invoice line). Nullable —
  -- informational, not load-bearing.
  "period_start"            TIMESTAMPTZ,
  "period_end"              TIMESTAMPTZ,

  -- Attribution context (re-derived SERVER-SIDE at checkout, never trusted
  -- from the client — see attribution-validator.service.ts + the FIN-1
  -- threading in createSubscribeSession). scope is the membership scope
  -- ('subscription'); a future model/page split can add others.
  "app_id"                  TEXT NOT NULL REFERENCES "OauthClient"("id") ON DELETE RESTRICT,
  "app_block_id"            TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE RESTRICT,
  "block_instance_id"       TEXT NOT NULL,
  "scope"                   TEXT NOT NULL,
  -- Optional: model the user was browsing when the CTA fired. Analytics.
  "model_id"                INTEGER,
  -- Membership tier at write time (analytics / future tier-weighted rate).
  "tier"                    TEXT,

  -- Revenue share (computed at attribution time against the active rate
  -- card's SUBSCRIPTION dimension). Denormalized rate_card_version so the
  -- row pays out under its stamped snapshot forever.
  -- TRACK-ONLY (#2629): no rate is applied at write time. rate_card_version
  -- is the 'unrated' sentinel and subscription_share_pct / app_owner_share_cents
  -- default to 0 until the payout-time backpay computes the real share.
  "rate_card_version"       TEXT NOT NULL DEFAULT 'unrated',
  "subscription_share_pct"  INTEGER NOT NULL DEFAULT 0,
  "app_owner_share_cents"   INTEGER NOT NULL DEFAULT 0,
  "platform_share_cents"    INTEGER NOT NULL,
  "provider_fee_cents"      INTEGER NOT NULL,
  -- Denormalized publisher user — snapshot at attribution time.
  "app_owner_user_id"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,

  -- Lifecycle. 'tracked' is the TRACK-ONLY state (#2629): the event + money
  -- basis are recorded but no share is computed yet — the payout-time backpay
  -- promotes tracked → a computed state. The other states mirror
  -- block_buzz_attribution's machine so the eventual payout aggregator can
  -- treat the flows uniformly. entry_type 'charge' (forward attribution) |
  -- 'clawback' (negative carry-forward, reserved for the payout slice).
  "status"                  TEXT NOT NULL DEFAULT 'tracked',
  "entry_type"              TEXT NOT NULL DEFAULT 'charge',
  "voided_reason"           TEXT,
  "attributed_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmed_at"            TIMESTAMPTZ,
  "voided_at"               TIMESTAMPTZ,
  "paid_out_at"             TIMESTAMPTZ,
  "payout_id"               TEXT,

  -- IDEMPOTENCY: one attribution per (invoice, app block). A webhook retry
  -- for the same invoice.paid is a no-op (P2002 caught + treated as
  -- already-written). Each renewal invoice has its OWN invoice_id, so it
  -- writes its OWN row (renewals-pay). app_block_id is part of the key to
  -- mirror the purchase table + leave room for a future multi-block split.
  CONSTRAINT "block_subscription_attribution_invoice_app_uniq"
    UNIQUE ("invoice_id", "app_block_id"),

  CONSTRAINT "block_subscription_attribution_scope_check"
    CHECK ("scope" IN ('subscription')),
  CONSTRAINT "block_subscription_attribution_status_check"
    CHECK ("status" IN ('tracked', 'pending', 'confirmed', 'voided', 'paid_out', 'held')),
  CONSTRAINT "block_subscription_attribution_entry_type_check"
    CHECK ("entry_type" IN ('charge', 'clawback')),
  CONSTRAINT "block_subscription_attribution_voided_reason_check"
    CHECK (
      "voided_reason" IS NULL OR "voided_reason" IN (
        'refund', 'chargeback', 'proration', 'self_purchase',
        'internal_owner', 'manual_review'
      )
    ),
  CONSTRAINT "block_subscription_attribution_provider_check"
    CHECK ("payment_provider" IN ('stripe', 'paddle', 'nowpayments')),
  -- Non-negativity for the forward 'charge' rows. Clawback rows carry
  -- NEGATIVE shares/gross, so the non-negativity + conservation CHECKs are
  -- scoped to entry_type='charge' only.
  CONSTRAINT "block_subscription_attribution_amounts_nonneg_check"
    CHECK (
      "entry_type" <> 'charge' OR (
        "buzz_amount" >= 0 AND
        "gross_value_cents" >= 0 AND
        "subscription_share_pct" >= 0 AND
        "app_owner_share_cents" >= 0 AND
        "platform_share_cents" >= 0 AND
        "provider_fee_cents" >= 0
      )
    ),
  -- Conservation: fee + platform + author = gross (charge rows only).
  -- A membership payment is a real card transaction split three ways.
  -- Catches rate-card arithmetic bugs at write time.
  CONSTRAINT "block_subscription_attribution_share_sum_check"
    CHECK (
      "entry_type" <> 'charge' OR (
        "provider_fee_cents" + "platform_share_cents" + "app_owner_share_cents"
        = "gross_value_cents"
      )
    ),
  -- Bound the TEXT primary key length. 'bsu_' (4) + 26 Crockford base32
  -- chars = 30 total.
  CONSTRAINT "block_subscription_attribution_id_length_check"
    CHECK (char_length("id") BETWEEN 28 AND 40)
);

-- Publisher dashboard: "show me my subscription revenue across all apps".
CREATE INDEX "bsu_publisher_dashboard_idx"
  ON "block_subscription_attribution" ("app_owner_user_id", "attributed_at" DESC);

-- Per-app drilldown.
CREATE INDEX "bsu_app_block_dashboard_idx"
  ON "block_subscription_attribution" ("app_block_id", "attributed_at" DESC);

-- Subscription lifecycle reconcile: find all periods for a subscription
-- (refund/proration clawback hooks scan by subscription_id).
CREATE INDEX "bsu_subscription_idx"
  ON "block_subscription_attribution" ("subscription_id");

-- Refund/clawback webhook lookup: void by (provider, invoice_id).
CREATE INDEX "bsu_invoice_idx"
  ON "block_subscription_attribution" ("payment_provider", "invoice_id");

-- Payout job: scan only confirmed-unpaid rows ordered by confirm time.
CREATE INDEX "bsu_payout_idx"
  ON "block_subscription_attribution" ("status", "confirmed_at")
  WHERE "status" = 'confirmed';

-- Confirm-pending cron: scan only pending rows ordered by attribution time.
CREATE INDEX "bsu_pending_aging_idx"
  ON "block_subscription_attribution" ("status", "attributed_at")
  WHERE "status" = 'pending';
