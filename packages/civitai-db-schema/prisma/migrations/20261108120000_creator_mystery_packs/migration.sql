-- Creator mystery packs: a box a creator builds from their own cosmetics, whose sales pay them.
--
-- 1. "ItemDefinition"."sellerId": the user a box's sales pay. NULL is a platform box, which pays no
--    one; every existing row stays NULL. Only a box may have one. ON DELETE RESTRICT: accounts are
--    soft-deleted ("User"."deletedAt"), so a hard delete of a seller is refused rather than leaving a
--    box whose sales pay no one.
-- 2. "BoxRevision": a creator's proposed next version of their box, waiting for review. At most one
--    pending revision per box.
--
-- Additive only: a new nullable column, a new table, no rows move. Nothing reads either until the
-- creator mystery pack code ships, so it can be applied before or after that deploy. Runs in one
-- transaction.
--
-- The ALTERs take an ACCESS EXCLUSIVE lock on "ItemDefinition", which every box open reads FOR SHARE.
-- The table is small, so the lock is brief, but waiting for it would queue every open behind it: the
-- lock_timeout makes the migration give up instead. If it times out, run it again.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ItemDefinition"
  ADD COLUMN IF NOT EXISTS "sellerId" INTEGER REFERENCES "User"("id") ON DELETE RESTRICT;

ALTER TABLE "ItemDefinition" DROP CONSTRAINT IF EXISTS "ItemDefinition_sellerId_box_check";
ALTER TABLE "ItemDefinition"
  ADD CONSTRAINT "ItemDefinition_sellerId_box_check"
  CHECK ("sellerId" IS NULL OR "type" = 'box');

CREATE INDEX IF NOT EXISTS "ItemDefinition_sellerId_idx"
  ON "ItemDefinition" ("sellerId")
  WHERE "sellerId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "BoxRevision" (
  "id"              SERIAL PRIMARY KEY,
  "boxDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE CASCADE,
  "baseVersion"     INTEGER NOT NULL,
  "proposal"        JSONB NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending'
                    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn', 'stale')),
  "appliedVersion"  INTEGER,
  "submittedById"   INTEGER NOT NULL,
  "reviewedById"    INTEGER,
  "reviewedAt"      TIMESTAMP(3),
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "BoxRevision_one_pending_key"
  ON "BoxRevision" ("boxDefinitionId")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "BoxRevision_boxDefinitionId_createdAt_idx"
  ON "BoxRevision" ("boxDefinitionId", "createdAt");

COMMIT;
