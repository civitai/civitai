-- Per-user "follow" rows for a crucible. Drives crucible-ending-soon and crucible-results.
-- Entrants are NOT stored here; they are derived at send time from CrucibleEntry.
--
-- MANUAL APPLY: this repo does not run `prisma migrate deploy`. Apply to each environment
-- BEFORE the code ships, or the follow toggle and the ending-soon query error.
--
-- Idempotent. The table is new and empty, so plain CREATE INDEX takes no meaningful lock.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CrucibleEngagementType') THEN
    CREATE TYPE "CrucibleEngagementType" AS ENUM ('Notify');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "CrucibleEngagement" (
  "userId"     INTEGER NOT NULL,
  "crucibleId" INTEGER NOT NULL,
  "type"       "CrucibleEngagementType" NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrucibleEngagement_pkey" PRIMARY KEY ("type", "crucibleId", "userId")
);

CREATE INDEX IF NOT EXISTS "CrucibleEngagement_crucibleId_idx"
  ON "CrucibleEngagement"("crucibleId");

CREATE INDEX IF NOT EXISTS "CrucibleEngagement_userId_idx"
  ON "CrucibleEngagement" USING HASH ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrucibleEngagement_userId_fkey'
  ) THEN
    ALTER TABLE "CrucibleEngagement"
      ADD CONSTRAINT "CrucibleEngagement_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrucibleEngagement_crucibleId_fkey'
  ) THEN
    ALTER TABLE "CrucibleEngagement"
      ADD CONSTRAINT "CrucibleEngagement_crucibleId_fkey"
      FOREIGN KEY ("crucibleId") REFERENCES "Crucible"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
