-- Version showcase: a row the image's author or a moderator removed stays as a tombstone, so the
-- model's owner can't feature the same image again. Readers skip tombstoned rows.
--
-- MANUAL APPLY, after 20270104120000_model_version_showcase_item (same release; apply both before
-- the version showcase code merges). CI and deploys do not run it.
--
-- LOCKING: ADD COLUMN with a constant default is catalog-only on Postgres 11+; `lock_timeout`
-- bounds the wait.
--
-- ROLLBACK: `ALTER TABLE "ModelVersionShowcaseItem" DROP COLUMN IF EXISTS "removed";`
-- (the owner can then re-add images their authors or a moderator removed).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ModelVersionShowcaseItem"
  ADD COLUMN IF NOT EXISTS "removed" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
