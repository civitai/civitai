-- Which Buzz a placement was paid in, so settlement can pay the same kind back.
--
-- APPLY BEFORE deploying the app that writes this column. The column is nullable
-- with no default, so an old pod writing a row without it stays valid.
--
-- THERE IS DELIBERATELY NO BACKFILL, and that is the load-bearing decision here.
--
-- Every placement made before this column existed was HELD as yellow whatever
-- the placer spent: the escrow debit named no destination account, so the Buzz
-- service credited the escrow account its default, and green was converted to
-- yellow on the way IN. Verified in ClickHouse `buzzTransactions` — the hold
-- legs read `fromAccountType: green, toAccountType: yellow`.
--
-- So for an existing row the escrow genuinely contains YELLOW, whatever the
-- placer originally spent. Backfilling the true spend type from the ledger would
-- make settlement pay out green the escrow never received. NULL must mean
-- "legacy: held as yellow, settle as yellow", and the application reads it that
-- way.
--
-- At the time of writing that is 8 production rows, 7 already settled and 1
-- pending, so the cost of leaving them alone is one placement settling in the
-- currency it is actually funded in.

-- 1.
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "spendType" TEXT;

-- 2. The same shape as "Placement_removedBy_check": the column is TEXT because
--    Prisma models it as a string, and the constraint is what actually keeps a
--    typo'd or newly-invented currency out of a column the settlement pays from.
--
--    Only the two purchasable types are allowed. Blue is excluded because a
--    placement that took Blue and paid it out would be a transfer channel for
--    non-transferable Buzz — the same reason PLACEMENT_SPEND_TYPES excludes it —
--    and adding it here must be a deliberate edit rather than a string that
--    happens to reach a write.
ALTER TABLE "Placement" DROP CONSTRAINT IF EXISTS "Placement_spendType_check";
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_spendType_check"
  CHECK ("spendType" IS NULL OR "spendType" IN ('green', 'yellow'));

-- 3. VERIFY. Step 1 is a no-op on retry and step 2 reports success either way,
--    so confirm both landed rather than reading a clean exit as proof:
--
--      SELECT column_name, is_nullable, data_type
--      FROM information_schema.columns
--      WHERE table_name = 'Placement' AND column_name = 'spendType';
--
--      SELECT conname, pg_get_constraintdef(oid)
--      FROM pg_constraint
--      WHERE conrelid = '"Placement"'::regclass AND conname = 'Placement_spendType_check';
--
--    Expect one row each: a nullable `text` column, and a CHECK naming both
--    'green' and 'yellow'. A missing constraint is not cosmetic — it is the only
--    thing standing between a bad write and a payout in a currency that does not
--    exist.
