-- The ProfilePictureHold table and the ProfilePictureSync queue type. Applied by hand.
--
-- Apply AFTER the client that knows `ProfilePictureSync` is deployed (civitai/civitai#8150), and
-- BEFORE the code that reads or writes the table. Nothing writes either until a later migration adds
-- the trigger that queues rows, so both statements are additive: no existing row changes.
--
-- The enum value is added on its own, outside the transaction below.
--
-- The foreign key takes a SHARE ROW EXCLUSIVE lock on "Image" while the table is created: better to
-- fail fast than to queue behind a long transaction and block every write to "Image". A lock
-- timeout rolls the transaction back; re-run it only after a failure.
--
-- Dry run: the transaction below, with COMMIT replaced by ROLLBACK. (ADD VALUE IF NOT EXISTS is
-- safe to run before it and to re-run.)
--
-- GRANTS, A REQUIRED STEP. New tables can be granted to roles automatically in this environment.
-- This one must not be readable by any role beyond the ones below, so after this file, with the
-- environment's actual role names, revoke every privilege from every other role that holds one, then
-- grant:
--   GRANT SELECT, INSERT, DELETE ON "ProfilePictureHold" TO <app_write_role>;
--   GRANT USAGE ON SEQUENCE "ProfilePictureHold_id_seq" TO <app_write_role>;
--   GRANT SELECT ON "ProfilePictureHold" TO <app_read_role>;
--   GRANT SELECT ON "ProfilePictureHold" TO <moderator_read_role>;
-- where:
--   - <app_write_role> is the role the main app's primary (write) client connects as;
--   - <app_read_role> is the role the main app's read client connects as;
--   - <moderator_read_role> is the role the moderator app connects as.
-- Then read the table's ACL back (`\dp "ProfilePictureHold"`) and check that it lists exactly
-- those roles with exactly those privileges, plus the owner.

ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ProfilePictureSync';

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ProfilePictureHold" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "imageId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfilePictureHold_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProfilePictureHold_reason_check" CHECK ("reason" IN ('blocked', 'flagged'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProfilePictureHold_imageId_key" ON "ProfilePictureHold"("imageId");
CREATE INDEX IF NOT EXISTS "ProfilePictureHold_userId_createdAt_idx"
  ON "ProfilePictureHold"("userId", "createdAt" DESC);

REVOKE ALL ON "ProfilePictureHold" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ProfilePictureHold_id_seq" FROM PUBLIC;

COMMIT;
