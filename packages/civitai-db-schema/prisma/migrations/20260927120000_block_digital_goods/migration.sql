-- ============================================================
-- App Blocks — DIGITAL GOODS: the purchase ledger + the entitlement
-- ============================================================
-- A generic rail for an app to sell an entitlement to a viewer for Buzz. The
-- platform owns the LEDGER — who bought which good, when, at what price, and
-- its refund state. The good's MEANING is the app's business: `payload` is an
-- opaque blob copied from the approved manifest and never interpreted here.
--
-- 🔴 TWO TABLES, NOT ONE, AND THE SPLIT IS THE POINT. `block_good_purchase` is
--    financial history and is never deleted; `block_good_entitlement` is what
--    the viewer currently owns and IS revoked on a refund. Folding them would
--    make "revoke what they own" and "keep what they paid" the same row, and
--    one of the two would have to lose.
--
-- 🔴 THE PAYOUT IS IMMEDIATE, NOT A DAILY BATCH — the cosmetic shop's shape,
--    not the author fee's. The buyer is debited to the bank (TransactionType
--    .Purchase) and the app owner credited from it (.Sell) inside the same
--    request, so there is no accrual state and no settlement job here. What
--    that costs is the `payouts` column below; what it buys is that an app
--    owner is paid at the moment of sale.
--
-- 🔴 `payouts` RECORDS WHAT WAS ACTUALLY PAID, per recipient and colour, with
--    each leg's ledger transaction id. A refund reverses THOSE transactions. It
--    must never re-derive a split: the re-derived number can differ from what
--    the recipient received — a colour proration that floored differently, or a
--    share constant that has since moved — and the error lands on a real
--    person's balance. Same reasoning as `userCosmeticShopPurchases.meta`.
--
-- 🔴 MONEY CONSERVATION IS A CHECK, not a convention:
--    `platform_share_buzz + app_owner_share_buzz = price_buzz`. It catches a
--    split arithmetic bug at INSERT rather than at reconciliation, which is
--    what `block_buzz_attribution_share_sum_check` does for the card-purchase
--    table. There is no provider-fee term because no card is involved.
--
-- 🔴 FK POSTURE IS RESTRICT THROUGHOUT, mirroring every App Blocks financial
--    table. These rows outlive the app, the OAuth client and the account — a
--    CASCADE here would delete the evidence that a payment happened.
--
-- 🔴 `block_instance_id` IS NULLABLE AND IS NOT AN FK, for the reason the
--    attribution tables give: synthetic instance ids (`bus_pub_*`, `page_*`,
--    `ephemeral-*`) resolve to no row. NULL means the install context could not
--    be resolved. A purchase must never fail because attribution could not.
--
-- 🔴 `(user_id, app_block_id, good_id)` IS UNIQUE on the entitlement. That is
--    what makes "buying the same good twice yields one entitlement" true under
--    CONCURRENCY rather than by check-then-act. Goods are therefore
--    single-ownership BY CONSTRUCTION; a consumable (buy N uses) is a different
--    product and needs its own table, not a relaxed constraint here.
--
-- 🔴 `kind` IS WHAT LETS THE PAID-APP UNLOCK LAND WITHOUT A MIGRATION. An
--    `app_unlock` entitlement is recorded identically to any other and NOTHING
--    in the tree branches on it today; the access gate is a later change that
--    reads this column.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule): committed for history, NOT auto-applied.
--    A human applies this via psql/retool per environment. Nothing here runs
--    `prisma migrate deploy`.
--
-- 🔴 APPLY THIS BEFORE THE IMAGE ROLLS. It is purely ADDITIVE — two new tables
--    and no change to any existing one — so the running image cannot notice it:
--    Prisma full-row reads only break on a column the client does not know
--    about IN A TABLE IT READS, and neither table is read by any deployed
--    code. Applied first, they sit empty until the deploy, which is inert. The
--    reverse order is what fails, and it fails HARD rather than silently: every
--    purchase and every entitlement read names these tables, so against a
--    database without them the request errors.
--
-- 🔴 VERIFY THE APPLY, don't assume it:
--      DATABASE_URL=... pnpm --filter @civitai/db-schema drift
--    Run it against each environment after applying and before the code ships.

CREATE TABLE "block_good_purchase" (
  "id"                    TEXT        NOT NULL,

  -- The buyer. Always the verified block-token subject, never a body field.
  "user_id"               INTEGER     NOT NULL,

  "app_id"                TEXT        NOT NULL,
  "app_block_id"          TEXT        NOT NULL,
  -- See the nullable/no-FK note above.
  "block_instance_id"     TEXT,

  -- The manifest `goods[].id` bought, and the manifest `version` it was bought
  -- under. Together they explain a disputed price without needing the manifest
  -- that was live at the time — a later approved version may have repriced it.
  "good_id"               TEXT        NOT NULL,
  "manifest_version"      TEXT        NOT NULL,

  -- Whole Buzz. Always > 0 (CHECK below): a free good is not a sale.
  "price_buzz"            INTEGER     NOT NULL,
  -- How much of `price_buzz` came out of the BLUE (granted) account. Drives the
  -- proportional colour split of the payout, so a viewer paying blue cannot
  -- turn non-withdrawable Buzz into withdrawable earnings.
  "blue_paid_buzz"        INTEGER     NOT NULL DEFAULT 0,

  -- Resolved at WRITE time. An app that changes hands must not retroactively
  -- move earnings already paid to the previous owner.
  "app_owner_user_id"     INTEGER     NOT NULL,
  "app_owner_share_buzz"  INTEGER     NOT NULL,
  "platform_share_buzz"   INTEGER     NOT NULL,

  -- The deterministic `externalTransactionIdPrefix` the buyer's debit was made
  -- under: `block-good:<app_block_id>:<good_id>:<user_id>`. UNIQUE, and that is
  -- the LEDGER-backed half of idempotency — the Buzz service refuses a second
  -- charge on the same prefix, and this index is how that conflict becomes
  -- OBSERVABLE to us (the multi-account response does not surface it).
  "buzz_transaction_id"   TEXT        NOT NULL,

  -- `[{ userId, amount, color, transactionId? }]`. Empty until the payout leg
  -- runs — a purchase still carrying `[]` is exactly the set to re-run.
  "payouts"               JSONB       NOT NULL DEFAULT '[]'::jsonb,

  "status"                TEXT        NOT NULL DEFAULT 'paid',
  "refund_reason"         TEXT,
  "refunded_at"           TIMESTAMPTZ,

  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "block_good_purchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "block_good_purchase_buzz_transaction_id_key"
  ON "block_good_purchase" ("buzz_transaction_id");

-- The viewer's own purchase history.
CREATE INDEX "bgp_buyer_idx"
  ON "block_good_purchase" ("user_id", "created_at" DESC);

-- The app's sales, for the owner dashboard.
CREATE INDEX "bgp_app_block_idx"
  ON "block_good_purchase" ("app_block_id", "created_at" DESC);

-- Per-owner earnings across every app they own.
CREATE INDEX "bgp_owner_idx"
  ON "block_good_purchase" ("app_owner_user_id", "created_at" DESC);

-- A row exists only because a viewer was debited, so the price is strictly
-- positive and neither share can be negative.
ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_amounts_check"
  CHECK (
    "price_buzz" > 0 AND
    "blue_paid_buzz" >= 0 AND
    "blue_paid_buzz" <= "price_buzz" AND
    "app_owner_share_buzz" >= 0 AND
    "platform_share_buzz" >= 0
  );

-- 🔴 THE CONSERVATION CHECK. The two shares must account for the whole price —
-- no more (Buzz minted out of a rounding bug) and no less (Buzz destroyed by
-- one). This is the write-time catch for a split arithmetic error, and it is
-- the reason `computeBlockGoodSplit` floors the owner's share and gives the
-- platform the remainder rather than flooring both.
ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_share_sum_check"
  CHECK ("platform_share_buzz" + "app_owner_share_buzz" = "price_buzz");

ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_status_check"
  CHECK ("status" IN ('paid', 'refunded'));

-- A refunded row must carry when and why, and a paid row must carry neither —
-- so "was this reversed" is answerable from the row alone.
ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_refund_fields_check"
  CHECK (
    ("status" = 'refunded' AND "refunded_at" IS NOT NULL AND "refund_reason" IS NOT NULL) OR
    ("status" <> 'refunded' AND "refunded_at" IS NULL AND "refund_reason" IS NULL)
  );

-- `payouts` is read back and iterated by the refund path; an object or a scalar
-- there would make that loop silently do nothing.
ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_payouts_array_check"
  CHECK (jsonb_typeof("payouts") = 'array');

-- Bound the TEXT primary key length. 'bgp_' (4) + 26 Crockford base32 = 30.
ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_id_length_check"
  CHECK (char_length("id") BETWEEN 28 AND 40);

ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "OauthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_app_block_id_fkey"
  FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_good_purchase"
  ADD CONSTRAINT "block_good_purchase_app_owner_user_id_fkey"
  FOREIGN KEY ("app_owner_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "block_good_entitlement" (
  "id"             TEXT        NOT NULL,

  "user_id"        INTEGER     NOT NULL,
  "app_block_id"   TEXT        NOT NULL,

  "good_id"        TEXT        NOT NULL,
  -- 'good' | 'app_unlock'. See the note above on why the second value exists
  -- now and does nothing yet.
  "kind"           TEXT        NOT NULL DEFAULT 'good',
  -- The opaque app payload, snapshotted from the APPROVED manifest at purchase.
  -- Manifest-sourced rather than client-supplied precisely so that what an
  -- entitlement carries is something a moderator saw.
  "payload"        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- The purchase that granted it. One-to-one.
  "purchase_id"    TEXT        NOT NULL,

  "granted_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the purchase is refunded or the good is taken down. A revoked
  -- entitlement is KEPT, never deleted: the row is the audit trail of the
  -- reversal, and the read path filters on `revoked_at IS NULL`.
  "revoked_at"     TIMESTAMPTZ,
  "revoke_reason"  TEXT,

  CONSTRAINT "block_good_entitlement_pkey" PRIMARY KEY ("id")
);

-- 🔴 ONE ENTITLEMENT PER (viewer, app, good). The concurrency guarantee behind
-- "buying twice charges once": the second writer loses here rather than both
-- succeeding after both passed an application-level ownership check.
CREATE UNIQUE INDEX "block_good_entitlement_owner_good_uniq"
  ON "block_good_entitlement" ("user_id", "app_block_id", "good_id");

-- One-to-one with the purchase, so a refund cannot revoke two entitlements and
-- a re-grant after a refund repoints the row instead of forking it.
CREATE UNIQUE INDEX "block_good_entitlement_purchase_id_key"
  ON "block_good_entitlement" ("purchase_id");

-- The entitlements read: one app, one viewer.
CREATE INDEX "bge_app_viewer_idx"
  ON "block_good_entitlement" ("app_block_id", "user_id");

ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_kind_check"
  CHECK ("kind" IN ('good', 'app_unlock'));

-- Revocation is a pair: a reason without a time (or the reverse) makes "is this
-- live" unanswerable from the row, and the read path keys on `revoked_at`.
ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_revoke_fields_check"
  CHECK (
    ("revoked_at" IS NULL AND "revoke_reason" IS NULL) OR
    ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL)
  );

ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_payload_object_check"
  CHECK (jsonb_typeof("payload") = 'object');

-- 'bge_' (4) + 26 Crockford base32 = 30.
ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_id_length_check"
  CHECK (char_length("id") BETWEEN 28 AND 40);

ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_app_block_id_fkey"
  FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_good_entitlement"
  ADD CONSTRAINT "block_good_entitlement_purchase_id_fkey"
  FOREIGN KEY ("purchase_id") REFERENCES "block_good_purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
