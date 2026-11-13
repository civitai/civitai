-- Storylines: text items in a post's reading order (PostText), and their Comment v3 thread
-- (entity type `postText`, partition with its FK to PostText ON DELETE CASCADE).
--
-- MANUAL APPLY, per environment, BEFORE the PR that reads it merges. Applying early is safe for the
-- running code: nothing deployed reads or writes "PostText" or the `postText` enum value.
--
-- Apply statement by statement (psql autocommit, the default), off-peak, and re-run a statement that
-- times out. Every step is re-runnable.
--   Step 1 creates the table and its index (the FK briefly locks "Post").
--   Step 2 adds the enum value on its own: a new value cannot be used in the transaction that adds it.
--   Step 3 is one short transaction: attaching the partition briefly locks "CommentTopic", which every
--     comment read and write uses.
SET lock_timeout = '3s';

-- 1. Table.
CREATE TABLE IF NOT EXISTS "PostText" (
  "id"        SERIAL NOT NULL,
  "postId"    INTEGER NOT NULL,
  "userId"    INTEGER NOT NULL,
  "index"     INTEGER NOT NULL,
  "content"   TEXT NOT NULL,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "refused"   BOOLEAN NOT NULL DEFAULT false,
  "csamHeld"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PostText_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PostText_postId_index_idx" ON "PostText" ("postId", "index");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostText_postId_fkey') THEN
    ALTER TABLE "PostText" ADD CONSTRAINT "PostText_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Comment v3 entity type. On its own, outside the transaction below.
ALTER TYPE "CommentEntityType" ADD VALUE IF NOT EXISTS 'postText';

-- 3. Comment v3 partition. Deleting a text deletes its thread.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "CommentTopic_postText" PARTITION OF "CommentTopic" FOR VALUES IN ('postText');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommentTopic_postText_entityId_fkey') THEN
    ALTER TABLE "CommentTopic_postText"
      ADD CONSTRAINT "CommentTopic_postText_entityId_fkey"
      FOREIGN KEY ("entityId") REFERENCES "PostText" ("id") ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
