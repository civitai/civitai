-- Storylines: the Comment v3 thread of a PostText (entity type `postText`, partition with its FK to
-- PostText ON DELETE CASCADE).
--
-- MANUAL APPLY, per environment, AFTER 20270108093000_post_text and only once the release carrying
-- the Prisma client generated with `postText` in "CommentEntityType" is live: a client that predates
-- the value fails to read any row that holds it.
--
-- Apply statement by statement (psql autocommit, the default), off-peak, and re-run a statement that
-- times out. Every step is re-runnable.
--   Step 1 adds the enum value on its own: a new value cannot be used in the transaction that adds it.
--   Step 2 is one short transaction: attaching the partition briefly locks "CommentTopic", which every
--     comment read and write uses.
SET lock_timeout = '3s';

-- 1. Comment v3 entity type. On its own, outside the transaction below.
ALTER TYPE "CommentEntityType" ADD VALUE IF NOT EXISTS 'postText';

-- 2. Comment v3 partition. Deleting a text deletes its thread.
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
