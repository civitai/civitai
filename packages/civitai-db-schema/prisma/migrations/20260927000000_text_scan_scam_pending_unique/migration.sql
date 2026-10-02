-- One open scam case per user, so concurrent auto-mute verdicts cannot file two.
-- Index only. Apply by hand BEFORE deploying the code that files scam cases, and outside a
-- transaction (CONCURRENTLY). Unmodelled in schema.full.prisma: the service catches the P2002.
--
-- 1. Pre-check. Must return no rows; if it does, resolve the extra Pending cases first or the
--    build fails:
--      SELECT "userId", count(*) FROM "UserRestriction"
--      WHERE type = 'scam' AND status = 'Pending'
--      GROUP BY "userId" HAVING count(*) > 1;
--
-- 2. Create (below).
--
-- 3. Verify. A CONCURRENTLY build that fails part-way leaves an INVALID index behind, and
--    IF NOT EXISTS then skips it on a re-run. This must return true:
--      SELECT i.indisvalid FROM pg_index i
--      WHERE i.indexrelid = '"UserRestriction_scam_pending_key"'::regclass;
--    If it returns false, drop it and run step 2 again:
--      DROP INDEX CONCURRENTLY IF EXISTS "UserRestriction_scam_pending_key";
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UserRestriction_scam_pending_key"
  ON "UserRestriction" ("userId")
  WHERE type = 'scam' AND status = 'Pending';
