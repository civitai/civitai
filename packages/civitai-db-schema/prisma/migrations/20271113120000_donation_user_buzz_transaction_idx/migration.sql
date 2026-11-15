-- Index for donateToGoal's keyed "already recorded?" lookup, which runs before charging and
-- again inside the charge-key lock transaction on the primary:
--   SELECT id FROM "Donation" WHERE "buzzTransactionId" = $1 AND "userId" = $2 LIMIT 1
-- Without it that lookup is a sequential scan of "Donation" on every keyed donation, and the
-- common case (not yet recorded) scans the whole table. Equality on both columns, so a plain
-- btree; userId first also serves the User ON DELETE CASCADE, which has no index on "Donation".
--
-- MANUAL APPLY, per environment. CONCURRENTLY cannot run inside a transaction, so run this ONE
-- statement on its own, outside BEGIN/COMMIT (the BEGIN; ... ROLLBACK; dry run does not apply to
-- it). IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying,
-- check pg_index.indisvalid, and if false run
-- `DROP INDEX CONCURRENTLY IF EXISTS "Donation_userId_buzzTransactionId_idx"` and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Donation_userId_buzzTransactionId_idx"
  ON "Donation" ("userId", "buzzTransactionId");
