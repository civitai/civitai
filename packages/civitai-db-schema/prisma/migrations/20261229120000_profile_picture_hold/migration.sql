-- The ProfilePictureHold table and the ProfilePictureSync queue type. Applied by hand.
--
-- Apply AFTER the client that knows `ProfilePictureSync` (civitai/civitai#8150) and the `exportable`
-- column (civitai/civitai#8163) is deployed, and
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
-- Apply as the role that owns "Image", not as an app role: the table's owner keeps every privilege.
--
-- GRANTS, A REQUIRED STEP. New tables can be granted to roles automatically in this environment.
-- This one must not be readable by any role beyond the ones below. After this file, with the
-- environment's actual role names, revoke every privilege on BOTH the table and its sequence
-- ("ProfilePictureHold_id_seq") from every other role that holds one, then grant:
--   GRANT SELECT, INSERT, DELETE ON "ProfilePictureHold" TO <app_write_role>;
--   GRANT USAGE ON SEQUENCE "ProfilePictureHold_id_seq" TO <app_write_role>;
-- where <app_write_role> is the role the primary (write) connection of the main app and of the
-- moderator app connects as. Every read of this table goes through that connection; no read-replica
-- role is granted anything.
-- Then check every role, counting inherited membership and built-in roles, not only the ACL:
--   SELECT rolname,
--     has_table_privilege(oid, '"ProfilePictureHold"', 'SELECT') AS can_read,
--     has_table_privilege(oid, '"ProfilePictureHold"', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_write,
--     has_sequence_privilege(oid, '"ProfilePictureHold_id_seq"', 'USAGE, SELECT, UPDATE') AS can_use_seq
--   FROM pg_roles
--   WHERE has_table_privilege(oid, '"ProfilePictureHold"', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
--      OR has_sequence_privilege(oid, '"ProfilePictureHold_id_seq"', 'USAGE, SELECT, UPDATE');
-- Expected: the role above, the owner, superusers, and roles that are members of the role above.
-- A member of the built-in pg_read_all_data role also reads it; report that as an exception rather
-- than a pass. Any other row is a role to revoke from (or to take out of that membership).

ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ProfilePictureSync';

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ProfilePictureHold" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "imageId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "exportable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfilePictureHold_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProfilePictureHold_reason_check" CHECK ("reason" IN ('blocked', 'flagged'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProfilePictureHold_imageId_reason_key"
  ON "ProfilePictureHold"("imageId", "reason");
CREATE INDEX IF NOT EXISTS "ProfilePictureHold_userId_createdAt_idx"
  ON "ProfilePictureHold"("userId", "createdAt" DESC);

REVOKE ALL ON "ProfilePictureHold" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ProfilePictureHold_id_seq" FROM PUBLIC;

COMMIT;
