-- ⛔ NOT BEING APPLIED. Justin's call, 2026-08-24: the ceiling is not currently reachable, so this
-- is not worth a production mutation on a 1.4-billion-row table. It is kept as the written record
-- of the numbers, the hazards and the precedent, so that whoever needs it next does not re-derive
-- any of it.
--
-- 🔴 WHAT THAT MEANS FOR THE CODE: the clamp in src/server/rewards/base.reward.ts is no longer a
-- backstop, it is the ONLY guard. CLICKHOUSE_MAX_MULTIPLIER = 9.99 is correct and must stay
-- correct — it has to equal the ceiling of the deployed column, which this file does not change.
-- Do not raise it while this is unapplied: a value the column cannot hold is a row ClickHouse
-- drops server-side while sendAward pays anyway.
--
-- Reopen this if a global bonus event above 2.5x is ever scheduled — see ClickUp 868kw9m36, which
-- carries that trigger.

-- buzzEvents.multiplier cannot hold the value the app computes.
--
-- The column is Decimal(3, 2) — 3 digits total, 2 after the point — so its ceiling is 9.99. The
-- stored value is the tier multiplier TIMES the global bonus event, and gold's 4 against
-- MAX_GLOBAL_BONUS of 5 is 20. Inserts run async_insert=1 with wait_for_async_insert=0, so a row
-- ClickHouse cannot parse is dropped server-side while the app sees success.
--
-- This is a payout value, not an audit one: for the four processable rewards (imagePostedToModel,
-- goodContent, collectedContent, reportAccepted) process-rewards reads the multiplier back out and
-- sendAward pays awardAmount * multiplier from it.
--
-- Not reachable today. The live bonus event is 2x, so gold members write 8, and the maximum across
-- 90 days is exactly 8 with no row at or above 9. Any bonus event above 2.5x tips it over.
--
-- ⚠️ THERE IS NO REHEARSAL ENVIRONMENT. Dev and preview both write to the production ClickHouse
-- cluster. Every step below runs once, in production, with no dry run available.
--
-- Measured 2026-08-24:
--   buzzEvents         1,456,460,568 rows, 13.61 GiB on disk, 61 active parts, 36 partitions
--   multiplier column  22.03 MiB compressed, 5.13 GiB UNCOMPRESSED  <-- the mutation rewrites this
--   views or materialized views referencing buzzEvents: 0
--     (control: the same query with the filter removed finds 57 views in the database, so the
--      zero is a finding rather than a broken filter — there is no MODIFY QUERY to pair with this)
--
-- WHY NOT `MODIFY COLUMN`: because this table records someone doing exactly this before, and they
-- chose otherwise. system.mutations still holds it:
--   2024-04-04 06:01  UPDATE multiplier = CAST(multiplier_old, 'Decimal(3, 2)') WHERE 1 = 1
--   2024-04-04 06:41  DROP COLUMN multiplier_old
-- Three reversible steps with an observable state between each, instead of one in-place rewrite
-- that cannot be inspected halfway through. Their reasoning is not recorded but their choice is,
-- and it means nobody has to know what KILL MUTATION does to a half-finished rewrite — there is
-- never a half-finished rewrite. Until the final DROP, the original column is intact and
-- authoritative, so the worst case at every step is a wasted rewrite rather than a damaged ledger.

-- STEP 1 — rename and add, in ONE statement.
--
-- 🔴 Do not split this into two. Between a bare RENAME and a bare ADD there is no column named
-- `multiplier`, and an insert naming it would fail to parse — which, on the async path, is a
-- silently dropped row. One statement, no window.
--
-- ⚠️ VERIFY BEFORE RUNNING: `DEFAULT multiplier_old` is what makes unmutated parts read correctly
-- while step 3 is still running. Without it the new column reads its own default of 1 for every
-- row the cast has not reached yet, and process-rewards would pay those pending rows at 1x — an
-- underpay caused by the migration itself. Confirm ClickHouse accepts a DEFAULT expression
-- referencing another column here; if it does not, step 3 must complete before any pending row is
-- processed, and this needs a quiet window rather than a checkpoint.

ALTER TABLE buzzEvents
  RENAME COLUMN multiplier TO multiplier_old,
  ADD COLUMN multiplier Decimal(4, 2) DEFAULT multiplier_old;

-- CHECKPOINT 1 — both columns present, new one reading the old values:
--   SELECT name, type, default_expression FROM system.columns
--   WHERE database = 'default' AND table = 'buzzEvents' AND name LIKE 'multiplier%';
--   SELECT countIf(multiplier != multiplier_old) FROM buzzEvents WHERE time > now() - INTERVAL 1 DAY;
-- The second must be 0. If it is not, STOP — do not run step 2.

-- STEP 2 — materialise the values. This is the mutation, and the only expensive step:
-- 1.4 billion rows, 5.13 GiB uncompressed.

ALTER TABLE buzzEvents UPDATE multiplier = CAST(multiplier_old, 'Decimal(4, 2)') WHERE 1 = 1;

-- CHECKPOINT 2 — watch it to completion. Do not treat the ALTER returning as done:
--   SELECT command, parts_to_do, is_done, latest_fail_reason
--   FROM system.mutations WHERE table = 'buzzEvents' AND NOT is_done;
--
-- If it goes wrong: KILL MUTATION WHERE table = 'buzzEvents' AND NOT is_done, then drop the new
-- column and start over. `multiplier_old` still holds every value, so nothing is lost.

-- STEP 3 — only once checkpoint 2 shows is_done = 1 and the values agree.
--
-- 🔴 Not the same day. Leaving `multiplier_old` in place for a while costs 22 MiB and is the only
-- rollback that exists after this runs.

-- ALTER TABLE buzzEvents DROP COLUMN multiplier_old;

-- 🔴 AFTERWARDS — THIS MIGRATION BUYS NOTHING WITHOUT IT.
--
-- CLICKHOUSE_MAX_MULTIPLIER in src/server/rewards/base.reward.ts is 9.99 and clamps to it, and
-- that clamp is what pays: process-rewards reads the multiplier back out and sendAward computes
-- awardAmount * multiplier from it. Widening the column and leaving the constant alone means a
-- 1.4-billion-row rewrite that changes nothing — gold members are still paid half during a 5x
-- bonus event, just against a column with room to spare.
--
-- Raise it to 99.99 and deploy, IN THAT ORDER, after step 2 completes. Not before: the constant
-- has to match the column that is actually deployed, and this file is applied by hand.
--
-- Keep the clamp itself. It is the backstop, and the code must stay correct on a database where
-- this has not been run.
