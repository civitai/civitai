-- ============================================================
-- Notifications: when each user was last sent the weekly missed-notification digest
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- APPLY IT BEFORE turning on the `missed-notification-digest` flag. The code tolerates the table
-- being absent: the model is marked no-type in `schema.full.prisma`, so the generated Prisma client
-- never names it, and every read and write is raw SQL in
-- `src/server/services/notification-digest.service.ts`, which treats a missing table (42P01) as
-- "cannot record a send" and sends nothing for that run. With the flag off nothing reads it.
--
-- WHAT IT HOLDS. One row per user who has been sent a digest OR has been started: `lastSentAt` is
-- when the latest one was sent, or, for a user not yet sent one, their start floor (the first pass
-- they were eligible, which sends nothing). The job skips a user sent one in the last six days, and
-- starts the next digest's window at `lastSentAt`, so no notification is listed in two digests and
-- none from before the user was enabled.
--
-- Additive and idempotent (`IF NOT EXISTS`). A new, empty table: no backfill, no rewrite of an
-- existing table. Creating the foreign key takes a SHARE ROW EXCLUSIVE lock on "User" for the
-- moment of the CREATE; `lock_timeout` makes it abort rather than queue behind a long transaction.
-- On `canceling statement due to lock timeout`, nothing was applied: re-run.
--
-- ROLLBACK: none needed for the code (it reads an absent table as "send nothing"). Dropping the
-- table forgets who was sent a digest this week, so the next run could send a second one.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "UserNotificationDigest" (
  "userId"     INTEGER      NOT NULL,
  "lastSentAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserNotificationDigest_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "UserNotificationDigest_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- VERIFY THE SCHEMA. `IF NOT EXISTS` reports success either way. Must return exactly two rows:
-- userId integer NO, lastSentAt timestamp without time zone NO.
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'UserNotificationDigest'
--   ORDER BY ordinal_position;
--
-- VERIFY THE BEHAVIOUR, after a digest run with the flag on. The FIRST run that reaches a newly
-- enabled user sends them nothing: its `notification-digest` log line reports `emailed` 0 and
-- `skipped.first-pass` > 0. Each run,
--
--   SELECT count(*), max("lastSentAt") FROM "UserNotificationDigest";
--
-- grows by `skipped.first-pass` rows; `emailed` users move their existing row's `lastSentAt` instead.
