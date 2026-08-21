-- Creator announcements (CU 868ktjte1).
--
-- Applied by hand, like every migration here. 🔴 Run it with ON_ERROR_STOP:
--   psql -v ON_ERROR_STOP=1 -f migration.sql
-- Without it psql continues past a failure, and a timed-out FK leaves the app running with
-- the constraint simply absent.
--
-- 🔴 EVERY statement is idempotent, and that is not decoration. The first prod attempt
-- (2026-08-19) added the three columns and then hit `canceling statement due to lock
-- timeout` on the first FK, leaving the database half-applied — at which point re-running a
-- non-idempotent file fails on `column "userId" already exists`, BEFORE reaching the work
-- that still needs doing. Re-running this file is now always safe and always resumes.
--
-- ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on the REFERENCED table, which conflicts with
-- every write to "Image" and "User". The timeout means this aborts rather than stalling
-- those writes behind it, so a timeout here is a retry, not a fault. If it keeps timing
-- out, run it in a quieter window rather than raising the ceiling — the ceiling is what
-- protects production from this migration.
SET lock_timeout = '5s';

-- 🔴 Guarded by a lookup, NOT by `ADD COLUMN IF NOT EXISTS` alone. ALTER TABLE takes
-- ACCESS EXCLUSIVE on "Announcement" before it evaluates IF NOT EXISTS, so on a re-run
-- where all three columns already exist it still queues for an exclusive lock and does no
-- work. "Announcement" is read on effectively every page load, so at peak that request
-- starves behind the stream of AccessShareLocks — three retries were lost here, on the
-- first statement, after the real work had already landed.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"Announcement"'::regclass AND attname = 'userId' AND NOT attisdropped
  ) THEN
    ALTER TABLE "Announcement"
      ADD COLUMN IF NOT EXISTS "userId" INTEGER,
      ADD COLUMN IF NOT EXISTS "coverId" INTEGER,
      ADD COLUMN IF NOT EXISTS "profileOnly" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Announcement_userId_fkey') THEN
    ALTER TABLE "Announcement"
      ADD CONSTRAINT "Announcement_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Announcement_coverId_fkey') THEN
    ALTER TABLE "Announcement"
      ADD CONSTRAINT "Announcement_coverId_fkey" FOREIGN KEY ("coverId")
        REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "UserAnnouncementMute" (
  "userId" INTEGER NOT NULL,
  "creatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAnnouncementMute_pkey" PRIMARY KEY ("userId", "creatorId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserAnnouncementMute_userId_fkey') THEN
    ALTER TABLE "UserAnnouncementMute"
      ADD CONSTRAINT "UserAnnouncementMute_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserAnnouncementMute_creatorId_fkey') THEN
    ALTER TABLE "UserAnnouncementMute"
      ADD CONSTRAINT "UserAnnouncementMute_creatorId_fkey" FOREIGN KEY ("creatorId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AnnouncementSpend" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "announcementId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AnnouncementSpend_userId_fkey') THEN
    ALTER TABLE "AnnouncementSpend"
      ADD CONSTRAINT "AnnouncementSpend_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AnnouncementSpend_announcementId_fkey') THEN
    ALTER TABLE "AnnouncementSpend"
      ADD CONSTRAINT "AnnouncementSpend_announcementId_fkey" FOREIGN KEY ("announcementId")
        REFERENCES "Announcement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Serves the author's own listing and the follower fan-out.
--
-- 🔴 Plain, NOT CONCURRENTLY, and that is the opposite of the usual advice for an existing
-- table — because "Announcement" is 310 rows / 264 kB. The build is sub-millisecond, so the
-- only cost is acquiring the lock. CONCURRENTLY needs TWO lock acquisitions and waits out
-- every in-flight transaction, which on a table read by every page load is the worst
-- possible shape at peak: on prod it was cancelled mid-build and left an INVALID index
-- behind, which `IF NOT EXISTS` will NOT replace — so every later retry skipped it and
-- reported success with no usable index. Size is what makes CONCURRENTLY worth its cost,
-- and this table has none.
CREATE INDEX IF NOT EXISTS "Announcement_userId_startsAt_idx"
  ON "Announcement"("userId", "startsAt");

-- Plain CREATE INDEX on the two tables created above: they are empty and brand new, so
-- CONCURRENTLY only adds a way to end up INVALID.
CREATE INDEX IF NOT EXISTS "UserAnnouncementMute_creatorId_idx"
  ON "UserAnnouncementMute"("creatorId");

CREATE INDEX IF NOT EXISTS "AnnouncementSpend_userId_createdAt_idx"
  ON "AnnouncementSpend"("userId", "createdAt");

-- The FK above is ON DELETE SET NULL, so every announcement delete looks for spends
-- pointing at it. Unique as well as indexed: one announcement can only ever have spent one
-- slot, which is what stops a replica-lagged second save charging the same row twice.
CREATE UNIQUE INDEX IF NOT EXISTS "AnnouncementSpend_announcementId_key"
  ON "AnnouncementSpend"("announcementId")
  WHERE "announcementId" IS NOT NULL;

RESET lock_timeout;
