-- ============================================================
-- Crucible comments — attach CommentsV2 to "Crucible"
-- ============================================================
-- Adds the polymorphic parent FK `Thread.crucibleId` (nullable, unique), exactly like
-- `Thread.challengeId`. The shared comment path resolves the thread by interpolating
-- `${entityType}Id`, so entity type `crucible` needs no further DB change.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. A human applies this per
-- environment (dev, then prod) BEFORE the code that reads/writes the column ships.
-- Idempotent: IF NOT EXISTS guards on the column and index, a pg_constraint guard on the FK.
--
-- LOCK NOTE: "Thread" is a hot, site-wide table. The unique index is built CONCURRENTLY, which
-- cannot run inside a transaction or DO block: run that ONE statement on its own, outside
-- BEGIN/COMMIT. If it fails mid-build it leaves an INVALID index; run
-- `DROP INDEX IF EXISTS "Thread_crucibleId_key"` and re-run it.

ALTER TABLE "Thread"
  ADD COLUMN IF NOT EXISTS "crucibleId" INTEGER;

-- RUN OUTSIDE ANY TRANSACTION.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Thread_crucibleId_key"
  ON "Thread" ("crucibleId");

-- NOT VALID skips the full-table validation scan; VALIDATE then takes only a light lock.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Thread_crucibleId_fkey'
  ) THEN
    ALTER TABLE "Thread"
      ADD CONSTRAINT "Thread_crucibleId_fkey"
      FOREIGN KEY ("crucibleId") REFERENCES "Crucible" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_crucibleId_fkey";
