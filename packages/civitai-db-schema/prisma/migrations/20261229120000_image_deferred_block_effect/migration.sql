-- A block's owner notice and report actioning, put off while the image is in CSAM review.
--
-- ORDER, A REQUIRED STEP: apply this BEFORE deploying the release that writes it. Every moderator
-- block names this table, so a release running without it fails every block, not only flagged ones.
--
-- The foreign key locks "Image" briefly. A lock timeout rolls everything back; re-run the file as
-- is, at a quieter moment if it times out again.
--
-- GRANTS, A REQUIRED STEP. Unless new tables are granted to the app roles automatically in this
-- environment, run after this file, with the environment's actual role names:
--   GRANT SELECT, INSERT, DELETE ON "ImageDeferredBlockEffect" TO <moderator_write_role>, <app_write_role>;
-- and check each with has_table_privilege('<role>', '"ImageDeferredBlockEffect"', '<privilege>').
-- Blocks insert; the close paths delete. No read role needs it.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The block's held check reads the CSAM queue's set-aside rows.
DO $$
BEGIN
  IF to_regclass('"CsamQueueSetAside"') IS NULL THEN
    RAISE EXCEPTION 'apply 20261209120000_csam_queue_set_aside first';
  END IF;
END $$;

CREATE TABLE "ImageDeferredBlockEffect" (
  "imageId" INTEGER NOT NULL,
  "violationType" TEXT,
  "blockedBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageDeferredBlockEffect_pkey" PRIMARY KEY ("imageId"),
  CONSTRAINT "ImageDeferredBlockEffect_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE
);
COMMIT;
