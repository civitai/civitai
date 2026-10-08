-- ============================================================
-- Feedback → app-block area: per-app private feedback (owner + moderators)
-- ============================================================
-- ADDITIVE ONLY. Eight NULLable columns, two foreign keys, two CHECKs and one
-- partial index on the existing "Feedback" table. No existing column is altered,
-- no existing row is rewritten, and "Feedback_status_check" (the moderator triage
-- vocabulary) is untouched.
--
-- ⚠️ MANUAL APPLY. This repo has no `prisma migrate deploy` in any deploy path; a
-- human applies the SQL below per environment (psql / retool). Apply to BOTH:
--   1. the dev database (the one PR previews use)
--   2. production
--
-- APPLY ORDER: apply BEFORE the code that declares these fields deploys. The
-- schema change in the same PR adds eight scalars to the Prisma `Feedback` model,
-- and a Prisma call on `feedback` with no explicit `select` emits
-- `RETURNING <every scalar the MODEL declares>` — P2022 against an unmigrated
-- database (the hazard `20260901120000_app_listing_beta` records). The hazard is
-- LATENT today: the one Prisma access to this table (`createFeedback` in
-- src/server/services/feedback.service.ts) passes `select: { id: true }`, and
-- Prisma 6.13 then emits `RETURNING "id"` only — measured against a table built
-- from the two earlier Feedback migrations, where the same create with no
-- `select` failed with P2022 on "appListingId". Re-check that before relying on
-- it: the guarantee is the explicit select. The server change that follows this
-- one adds more Prisma access, so treat the SQL as a prerequisite of the deploy.
-- Pre-applying is safe: nothing reads or writes these columns until then.
--
-- 🔴 TWO PARTS, run separately.
--   Part 1 is its own transaction (`BEGIN` ... `COMMIT` below) and MUST be run as
--   written, including the `BEGIN`: its `SET LOCAL lock_timeout` only takes effect
--   inside a transaction block (outside one Postgres warns and ignores it, so the
--   ALTERs would wait for their locks indefinitely). Run the whole block in one go
--   (psql, or one retool query).
--   Part 2 is `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a
--   transaction block — run it as its own statement AFTER Part 1 has committed
--   (psql without `-1`, or a separate retool query with transaction wrapping off),
--   and NOT under a lock_timeout: it takes a brief lock at both ends of the build,
--   and a timeout there fails dirty, leaving an INVALID index behind (see
--   `20260824120000_user_email_domain_index`). The `SET LOCAL` in Part 1 ends at
--   its `COMMIT`, so it cannot leak into Part 2; if your session sets a
--   lock_timeout of its own, `SET lock_timeout = 0;` before Part 2. Then run the
--   verification query at the bottom and confirm `indisvalid = true`. A failed
--   concurrent build leaves an INVALID index that `IF NOT EXISTS` will then
--   silently skip: if `indisvalid` is false,
--   `DROP INDEX CONCURRENTLY "Feedback_appListingId_createdAt_idx";` and re-run Part 2.
--
-- Idempotent: `IF NOT EXISTS` on every column and the index; the constraints go
-- through `pg_constraint` guards, because `ALTER TABLE ... ADD CONSTRAINT` has no
-- `IF NOT EXISTS` form in Postgres.
--
-- `ADD COLUMN ... NULL` with no default is metadata-only in Postgres 11+, so every
-- column is O(1) regardless of row count. Every existing row trivially satisfies the
-- FKs and CHECKs because the columns they constrain are created NULL above, so a
-- plain `ADD CONSTRAINT` (not `NOT VALID` + `VALIDATE`) is used, as in
-- `20260911120000_feedback_triage`; each still scans "Feedback" once to validate.
--
-- LOCKS — on THREE tables, brief, but not zero, all held until Part 1's COMMIT:
--   * "Feedback": ACCESS EXCLUSIVE (ADD COLUMN, ADD CHECK) — reads AND writes of
--     "Feedback" wait.
--   * "User" and "app_listings": SHARE ROW EXCLUSIVE, taken by each
--     `ADD CONSTRAINT ... FOREIGN KEY` on the table it REFERENCES — writes
--     (INSERT/UPDATE/DELETE) to those tables wait; reads do not.
-- The danger is the QUEUE, not the hold: if a long write transaction already holds
-- a row lock on "User", the FK's lock request waits behind it, and every later
-- "User" write queues behind the waiting request. `SET LOCAL lock_timeout = '3s'`
-- caps each lock wait at 3s, so Part 1 aborts instead of stalling every writer
-- queued behind it. So:
--   1. First check for long-running write transactions, e.g.
--        SELECT pid, now() - xact_start AS age, state, left(query, 80)
--          FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND state <> 'idle'
--         ORDER BY xact_start;
--   2. Run it off-peak.
--   3. On `canceling statement due to lock timeout`, nothing was applied (one
--      transaction; it rolls back whole): wait and re-run Part 1.

-- ------------------------------------------------------------
-- Part 1 — columns and constraints. ONE transaction, run as written.
-- ------------------------------------------------------------

BEGIN;

-- SET LOCAL, not SET: a bare SET is session-scoped, so it would leave a 3s lock_timeout on
-- whatever the operator runs next in the same session — Part 2 included, where a timeout
-- leaves an INVALID index.
SET LOCAL lock_timeout = '3s';

-- The PARENT listing the feedback is about. Always the seat listing, never a
-- shadow revision (`revisionOfId IS NOT NULL`) — a cross-row rule a CHECK cannot
-- express, so it is a service invariant of the code that writes this column.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "appListingId"        TEXT         NULL;
-- The block version live when the feedback was sent, stamped server-side. Not an
-- FK: "app_blocks" is one row per block, updated in place. NULL for off-site apps.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "appBlockVersion"     TEXT         NULL;
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "appBlockSha"         TEXT         NULL;
-- Owner (developer) status. SEPARATE from the moderator "status" / "triageNote" /
-- "handledBy*" columns, so an owner can never move moderator triage and neither
-- status drives the other. NULL = new to the developer.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "ownerStatus"         TEXT         NULL;
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "ownerStatusAt"       TIMESTAMP(3) NULL;
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "ownerStatusById"     INTEGER      NULL;
-- The owner flagged this report as abusive, for moderators.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "ownerFlaggedAt"      TIMESTAMP(3) NULL;
-- A moderator hid this report from the developer. No "who hid it" column: the
-- moderator who hides or unhides is recorded by the append-only "ModActivity" row the
-- server change writes on each action, and an unhide would null such a column anyway.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "hiddenFromOwnerAt"   TIMESTAMP(3) NULL;

DO $$
BEGIN
  -- SET NULL, not CASCADE: a deleted listing must not destroy the reporter's
  -- report for moderators. Owner access ends with it, because owner reads branch
  -- on this column. ON UPDATE CASCADE matches what Prisma emits for a relation on
  -- this schema; without it the table lands pre-drifted from `schema.full.prisma`.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_appListingId_fkey') THEN
    ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_appListingId_fkey"
      FOREIGN KEY ("appListingId") REFERENCES "app_listings"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_ownerStatusById_fkey') THEN
    ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_ownerStatusById_fkey"
      FOREIGN KEY ("ownerStatusById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  -- Mirrors FEEDBACK_OWNER_STATUSES in packages/civitai-shared/src/feedback.constants.ts.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_ownerStatus_check') THEN
    ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_ownerStatus_check"
      CHECK ("ownerStatus" IS NULL OR "ownerStatus" IN ('acknowledged', 'resolved', 'wont_fix'));
  END IF;
  -- All eight columns this migration adds must be NULL unless "area" = 'app-block'.
  -- One-directional: it requires nothing OF an app-block row. Deliberately NOT
  -- "area = 'app-block' ⇒ appListingId IS NOT NULL": ON DELETE SET NULL must be
  -- able to null it when the listing is deleted (and "ownerStatusById" when the
  -- user is), and setting a column NULL can never violate this CHECK.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_app_columns_check') THEN
    ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_app_columns_check"
      CHECK ("area" = 'app-block'
             OR ("appListingId" IS NULL AND "appBlockVersion" IS NULL AND "appBlockSha" IS NULL
                 AND "ownerStatus" IS NULL AND "ownerStatusAt" IS NULL
                 AND "ownerStatusById" IS NULL AND "ownerFlaggedAt" IS NULL
                 AND "hiddenFromOwnerAt" IS NULL));
  END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- Part 2 — owner-inbox index. OUTSIDE a transaction, after Part 1 commits, and
-- with NO lock_timeout (see the header).
-- ------------------------------------------------------------
-- "This listing's feedback, newest first". Partial: only app rows carry the
-- column, so every other area costs the index nothing. It also serves the
-- ON DELETE SET NULL scan when a listing is deleted (Postgres does not index an
-- FK by itself; `"appListingId" = $1` implies the predicate).
--
-- No separate rate-limit index: a per-user-per-listing count is
-- `WHERE "userId" = ? AND "createdAt" > ?` plus an "appListingId" filter, served
-- by "Feedback_userId_createdAt_idx". No moderator index either: an app-block
-- queue view (`WHERE "area" = 'app-block'`, by status, newest first) is served by
-- "Feedback_area_status_createdAt_idx". No index on the new user-id FK, the same
-- call `20260911120000_feedback_triage` made for "handledById".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Feedback_appListingId_createdAt_idx"
  ON "Feedback" ("appListingId", "createdAt" DESC)
  WHERE "appListingId" IS NOT NULL;

-- ------------------------------------------------------------
-- Verification (read-only) — run after both parts, per environment.
-- Expect: columns = 8, constraints = 4, and one index row with indisvalid = t.
-- ------------------------------------------------------------
-- SELECT count(*) AS columns
--   FROM information_schema.columns
--  WHERE table_schema = current_schema() AND table_name = 'Feedback'
--    AND column_name IN ('appListingId', 'appBlockVersion', 'appBlockSha', 'ownerStatus',
--                        'ownerStatusAt', 'ownerStatusById', 'ownerFlaggedAt',
--                        'hiddenFromOwnerAt');
-- SELECT count(*) AS constraints
--   FROM pg_constraint
--  WHERE conrelid = '"Feedback"'::regclass
--    AND conname IN ('Feedback_appListingId_fkey', 'Feedback_ownerStatusById_fkey',
--                    'Feedback_ownerStatus_check', 'Feedback_app_columns_check');
-- SELECT c.relname, i.indisvalid, i.indisready
--   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--  WHERE c.relname = 'Feedback_appListingId_createdAt_idx';
