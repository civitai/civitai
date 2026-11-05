-- Storyline follows: who is told about a storyline's new chapters, and which ones.
--
-- MANUAL APPLY, before the code that reads the table ships. Purely additive: a new enum and a new
-- table, nothing existing altered, so the deployed client is unaffected.
--
-- The foreign keys briefly take a SHARE ROW EXCLUSIVE lock on "Storyline" and "User"; with a lock
-- timeout a busy table fails fast and can be retried instead of stalling writes.
SET lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StorylineFollowScope') THEN
    CREATE TYPE "StorylineFollowScope" AS ENUM ('Canon', 'Endorsed', 'Everything');
  END IF;
END
$$;

-- The backfill runs only with the CREATE TABLE: re-running this file must not re-follow someone
-- who has since unfollowed. Owners and accepted collaborators follow from the start, as the
-- deployed code does for new storylines and newly accepted invitations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'StorylineFollow'
  ) THEN
    CREATE TABLE "StorylineFollow" (
      "storylineId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL,
      "scope" "StorylineFollowScope" NOT NULL DEFAULT 'Canon',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StorylineFollow_pkey" PRIMARY KEY ("storylineId", "userId"),
      CONSTRAINT "StorylineFollow_storylineId_fkey" FOREIGN KEY ("storylineId")
        REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "StorylineFollow_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX "StorylineFollow_userId_idx" ON "StorylineFollow"("userId");

    INSERT INTO "StorylineFollow" ("storylineId", "userId")
    SELECT id, "userId" FROM "Storyline"
    UNION
    SELECT "storylineId", "userId" FROM "StorylineCollaborator" WHERE "acceptedAt" IS NOT NULL;
  END IF;
END
$$;
