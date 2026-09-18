-- ============================================================
-- App Blocks — per-generation AUTHOR FEE: the accrual ledger
-- ============================================================
-- Slice 2 of the author fee (slice 1 = #4922, the computation, dark). This is the
-- first slice that MOVES MONEY, and this table is its ledger.
--
-- WHAT THE ROW MEANS. One row = one generation on which an app charged its
-- author fee. The viewer has ALREADY been debited `fee_buzz` at submit; this row
-- is the platform's obligation to pay it onward to the app owner, settled in a
-- daily batch. It mirrors the model licensing fee exactly: the orchestrator
-- charges the viewer at generation time and writes a per-resource fee row, and
-- `deliver-creator-compensation` mints to the creator daily. Same two hops, same
-- dedup discipline, in a civitai-owned table.
--
-- 🔴 WHY A NEW TABLE RATHER THAN COLUMNS ON block_spend_attribution. That row is
--    IMMUTABLE by design — it is written fire-and-forget off an already-billed
--    submit and nothing re-stamps it (which is why `rate_card_version` is still
--    the 'unrated' sentinel on every row in production). An accrual has a
--    LIFECYCLE: accrued -> settled, or accrued -> clawed_back. Putting a mutable
--    status on the immutable row would break the property the other table's
--    readers depend on.
--
-- 🔴 WHY THE AMOUNT IS AN INTEGER, NOT NUMERIC — this reverses the "fractional
--    accrual" the design carried over from the licensing rail, and the reversal
--    is deliberate. The licensing fee is fractional because it is priced
--    per-IMAGE at 0.01 buzz and the viewer is charged the CEILING of the sum, so
--    the creator's share genuinely has sub-buzz resolution. This fee does not:
--    it is `max(flatBuzz, pct x base)` FLOORED TO WHOLE BUZZ before the viewer is
--    ever shown or charged it (D7 requires the viewer see the exact number before
--    the run, and Buzz cannot express a fraction). The author is credited exactly
--    what the viewer paid — no more, because the platform takes no cut, and no
--    less, because the platform funds nothing. A NUMERIC column here would
--    promise a resolution that no code path can produce and invite a future
--    reader to "fix" the rounding by charging the viewer one number and paying
--    the author another.
--
--    ⚠️ THE CONSEQUENCE, AND IT IS REAL: an author who sets flat_buzz = 0 and a
--    low percentage earns NOTHING on cheap generations, permanently — floor(4 x
--    500/10000) = 0, every time. That is the same shape as the $0.00 spend bounty
--    this whole arc replaced. The difference is that it is now the AUTHOR'S
--    explicit choice and the platform default (flat = 1) avoids it. Slice 3's
--    config UI must say so at the point of setting it.
--
-- 🔴 buzz_type CARRIES D6. A viewer spending blue Buzz pays the fee in blue and
--    the author receives blue (non-withdrawable). The settlement job groups by it
--    and never coerces to yellow. Defaulting it would silently convert
--    non-withdrawable Buzz into withdrawable earnings.
--
-- 🔴 app_owner_user_id IS RESOLVED AT WRITE TIME, NOT AT SETTLEMENT. An app that
--    changes hands must not retroactively move earnings already accrued to the
--    previous owner (`app-ownership-transfer.service.ts` is the precedent).
--    Resolving the owner in the settlement query would do exactly that.
--
-- CLAWBACK. A generation that fails or partially delivers is refunded by the
-- orchestrator AFTER submit (the settled base drops below the submit-time base),
-- and the fee must follow or an author earns on a generation the viewer got their
-- money back on. Two paths, both keyed by `entry_type`:
--   * refund BEFORE settlement -> the 'accrual' row flips to status='clawed_back'
--     and the daily sum never sees it. Nothing was minted.
--   * refund AFTER settlement  -> a NEGATIVE 'clawback' row is written and the
--     next day's sum nets it off, the carry-forward shape already proven on the
--     other rail (`voidAttributionsForPayment`).
-- Hence the unique key is (workflow_id, entry_type): at most one accrual and at
-- most one clawback per workflow, and re-running either is a no-op.
--
-- ⚠️ MANUAL-APPLY: committed for history, NOT auto-applied. A human applies this
--    to the dev database and to prod out of band — the main civitai DB is not on
--    an auto-migrate path.
--
-- 🔴 APPLY THIS BEFORE THE CODE SHIPS, for the same reason #4903 did: the writer
--    always names these columns, so against a database without the table the
--    INSERT cannot succeed. Unlike #4903 the failure is NOT silent here — the
--    accrual write is awaited on the charge path, because a viewer who has been
--    debited and whose accrual did not land is a real loss, not a lost metric.
--    Applied first, the table sits empty until the code deploys, which is inert:
--    the settlement job no-ops on an empty scan and the whole path is behind
--    `app-blocks-author-fee-enabled`, which is false.
--
-- 🔴 VERIFY THE APPLY, don't assume it:
--      DATABASE_URL=... pnpm --filter @civitai/db-schema drift
--    Run it against each environment after applying and before the code ships.

CREATE TABLE "block_author_fee_accrual" (
  "id"                   TEXT        NOT NULL,

  -- The orchestrator workflow this fee was charged on. The idempotency anchor:
  -- a resubmit of the same workflow must never charge or accrue twice.
  "workflow_id"          TEXT        NOT NULL,

  -- 'accrual' (positive, the charge) or 'clawback' (negative, the carry-forward
  -- reversal of an already-settled accrual).
  "entry_type"           TEXT        NOT NULL DEFAULT 'accrual',

  "app_id"               TEXT        NOT NULL,
  "app_block_id"         TEXT        NOT NULL,

  -- Resolved at WRITE time. See the ownership note above.
  "app_owner_user_id"    INTEGER     NOT NULL,

  -- The viewer who paid. Needed for clawback and for abuse review; also what the
  -- self-dealing exclusion is measured against.
  "viewer_user_id"       INTEGER     NOT NULL,

  -- D6: the account the viewer paid from and the author is credited in.
  "buzz_type"            TEXT        NOT NULL,

  -- Whole Buzz. Positive on an 'accrual' row, negative on a 'clawback' row.
  "fee_buzz"             INTEGER     NOT NULL,

  -- The pricing inputs, kept so a disputed charge can be explained without
  -- re-deriving it from a workflow that may no longer exist.
  "base_generation_buzz" INTEGER     NOT NULL,
  "flat_leg_buzz"        INTEGER     NOT NULL,
  "pct_leg_buzz"         INTEGER     NOT NULL,
  "governing_leg"        TEXT        NOT NULL,

  -- The resolved '<coarse>' or '<coarse>:<subtype>' the fee was priced under.
  -- NULL when the type could not be resolved (the fee still applies — it falls to
  -- the app's default; see resolveBlockAuthorFeeParams).
  "generation_type"      TEXT,

  "status"               TEXT        NOT NULL DEFAULT 'accrued',

  -- The externalTransactionId this row settled under, so a row can be traced to
  -- the exact mint. NULL until settled.
  "settlement_key"       TEXT,

  "accrued_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "settled_at"           TIMESTAMPTZ,

  CONSTRAINT "block_author_fee_accrual_pkey" PRIMARY KEY ("id")
);

-- Idempotency: one accrual and one clawback per workflow, at most.
CREATE UNIQUE INDEX "block_author_fee_accrual_workflow_entry_key"
  ON "block_author_fee_accrual" ("workflow_id", "entry_type");

-- The settlement scan: everything still owed, oldest first.
CREATE INDEX "block_author_fee_accrual_settlement_idx"
  ON "block_author_fee_accrual" ("status", "accrued_at")
  WHERE "status" = 'accrued';

-- Per-owner history, for the author-facing earnings surface slice 3 adds.
CREATE INDEX "block_author_fee_accrual_owner_idx"
  ON "block_author_fee_accrual" ("app_owner_user_id", "accrued_at");

-- An accrual is owed money; a clawback returns it. Pinning the sign per
-- entry_type is what keeps a sign error from silently paying an author on a
-- reversal.
ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_amount_sign_check"
  CHECK (
    ("entry_type" = 'accrual'  AND "fee_buzz" >= 0) OR
    ("entry_type" = 'clawback' AND "fee_buzz" <= 0)
  );

-- ⚠️ SUBSUMED BY THE SIGN CHECK ABOVE, AND MEASURED TO BE — kept as an explicit
-- statement of the allowed set, NOT as a reachable guard. The sign check reads
-- `(entry_type='accrual' AND ...) OR (entry_type='clawback' AND ...)`, so ANY
-- third value makes both disjuncts false and is already rejected there. Verified
-- on the dev database 2026-09-18: an insert with entry_type='bogus' was rejected
-- by `..._amount_sign_check`, never by this one, and no input exists that can
-- reach it. Do not read it as coverage; if the sign check is ever loosened, this
-- becomes live and should be re-verified with its own negative control.
ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_entry_type_check"
  CHECK ("entry_type" IN ('accrual', 'clawback'));

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_status_check"
  CHECK ("status" IN ('accrued', 'settled', 'clawed_back'));

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_governing_leg_check"
  CHECK ("governing_leg" IN ('flat', 'pct', 'none'));

-- A settled row must carry the key it settled under, and an unsettled row must
-- not — so "did this get paid" is answerable from the row alone.
ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_settled_key_check"
  CHECK (
    ("status" = 'settled' AND "settlement_key" IS NOT NULL AND "settled_at" IS NOT NULL) OR
    ("status" <> 'settled' AND "settlement_key" IS NULL AND "settled_at" IS NULL)
  );

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "OauthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_app_block_id_fkey"
  FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_app_owner_user_id_fkey"
  FOREIGN KEY ("app_owner_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_viewer_user_id_fkey"
  FOREIGN KEY ("viewer_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
