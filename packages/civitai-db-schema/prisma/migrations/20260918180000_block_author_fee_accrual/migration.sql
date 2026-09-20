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
-- 🔴 WHY A NEW TABLE RATHER THAN COLUMNS ON block_spend_attribution.
--
--    ⚠️ NOT THE REASON AN EARLIER REVISION GAVE, WHICH WAS FALSE. It argued that
--    block_spend_attribution is "IMMUTABLE by design" and that a mutable status
--    would break what its readers depend on. It is not immutable: that model
--    already carries status, voided_reason, confirmed_at, voided_at, paid_out_at
--    and payout_id — the same accrued/settled/voided shape plus a payout key.
--    Those columns are merely DEAD today, because the rail that re-stamped them
--    was removed. "Nothing re-stamps it right now" is not "it is immutable", and
--    a reader who checks the schema finds the lifecycle columns and concludes the
--    rationale is wrong.
--
--    THE REAL REASON IS THE WRITE SEAM, not the row shape. recordSpendAttribution
--    is invoked inside `void (async () => { … })()` with its own try/catch
--    (src/server/routers/blocks.router.ts), explicitly so that "a failed
--    attribution write must NEVER break the generation" — it is droppable
--    telemetry off an already-billed submit. An accrual is a money obligation and
--    must be AWAITED: a viewer debited whose accrual did not land is a real loss
--    to a real author. Hanging an awaited financial write onto a deliberately
--    fire-and-forget path is the thing to avoid, and that is what separates them.
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
-- 🔴 NO CLAWBACK HERE, DELIBERATELY. A generation that fails or partially
-- delivers is refunded by the orchestrator AFTER submit, and the fee must follow
-- or an author earns on a generation the viewer got their money back on. That is
-- real and it is slice 2b's, together with the refund path that drives it.
-- Round 0 retired it from this PR: it had ZERO production callers, and its
-- negative carry-forward arm was unreachable until something had settled — at
-- least two PRs away. The reversal of a charge cannot be needed before the charge
-- exists, and shipping it early is how the repo's previous payout rail
-- (bulk-payout-block-attributions, built 2026-05-31) ended up still unwired.
-- So: no `entry_type` axis, no negative rows, one unique key on workflow_id.
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

  "app_id"               TEXT        NOT NULL,
  "app_block_id"         TEXT        NOT NULL,

  -- Resolved at WRITE time. See the ownership note above.
  "app_owner_user_id"    INTEGER     NOT NULL,

  -- The viewer who paid. What the self-dealing exclusion is measured against, and
  -- what slice 2b's refund path will join on to reverse a fee.
  "viewer_user_id"       INTEGER     NOT NULL,

  -- D6: the account the viewer paid from and the author is credited in.
  "buzz_type"            TEXT        NOT NULL,

  -- Whole Buzz owed to the author. Always > 0; see the CHECK below.
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

-- Idempotency: at most one accrual per workflow.
CREATE UNIQUE INDEX "block_author_fee_accrual_workflow_key"
  ON "block_author_fee_accrual" ("workflow_id");

-- The settlement scan: everything still owed, oldest first.
CREATE INDEX "block_author_fee_accrual_settlement_idx"
  ON "block_author_fee_accrual" ("status", "accrued_at")
  WHERE "status" = 'accrued';

-- Per-owner history, for the author-facing earnings surface slice 3 adds.
CREATE INDEX "block_author_fee_accrual_owner_idx"
  ON "block_author_fee_accrual" ("app_owner_user_id", "accrued_at");

-- A row exists only because a viewer was debited, so the amount is strictly
-- positive. This is what makes the settlement job's "a bucket can never sum to
-- <= 0" reasoning structural rather than a dead branch in the code.
ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_amount_positive_check"
  CHECK ("fee_buzz" > 0);


ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_status_check"
  CHECK ("status" IN ('accrued', 'settled'));

-- 🔴 D6's LAST LINE OF DEFENCE. The settlement job groups by this column and
-- casts it to BuzzAccountType unchecked, and that union also contains BANK
-- account types (creatorProgramBank, cashPending, cashSettled, club). Without
-- this, a future writer could put a bank account type — or junk — in the column
-- and the only symptom would be a transaction the Buzz service silently DROPS,
-- which is invisible by construction. The two spend accounts a viewer can pay a
-- block generation from are blue and yellow; green and red are included because
-- they are spend types a viewer can hold.
ALTER TABLE "block_author_fee_accrual"
  ADD CONSTRAINT "block_author_fee_accrual_buzz_type_check"
  CHECK ("buzz_type" IN ('blue', 'green', 'yellow', 'red'));

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
