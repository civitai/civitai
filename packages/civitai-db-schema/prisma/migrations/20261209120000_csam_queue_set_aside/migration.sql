-- Images a moderator took out of the CSAM review queue without changing the image itself. Apply it
-- BEFORE deploying the code that writes it (reads skip the table while it is missing).
-- The foreign keys and the trigger lock "Image" and "CsamReport" against writes: better to fail
-- fast than to queue behind a long transaction and block every write to them. A lock timeout rolls
-- everything back; re-run only after a failure.
--
-- GRANTS, A REQUIRED STEP. Unless new tables are granted to the app roles automatically in this
-- environment, run after this file, with the environment's actual role names:
--   GRANT SELECT, INSERT ON "CsamQueueSetAside" TO <moderator_write_role>;
--   GRANT SELECT, DELETE ON "CsamQueueSetAside" TO <app_write_role>;
--   GRANT SELECT ON "CsamQueueSetAside" TO <moderator_read_role>, <app_read_role>;
-- and check each with has_table_privilege('<role>', '"CsamQueueSetAside"', '<privilege>'). The
-- moderator app dismisses (insert) and reads the queue; the main app removes the rows of images it
-- reports. A role that cannot read the table sees the queue as if the table were missing. The
-- trigger runs as its owner, so it needs no grant.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');

CREATE TABLE "CsamQueueSetAside" (
  "imageId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "outcome" "CsamQueueSetAsideOutcome" NOT NULL,
  "csamReportId" INTEGER,
  "moderatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CsamQueueSetAside_pkey" PRIMARY KEY ("imageId"),
  CONSTRAINT "CsamQueueSetAside_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE,
  CONSTRAINT "CsamQueueSetAside_csamReportId_fkey" FOREIGN KEY ("csamReportId") REFERENCES "CsamReport"("id") ON DELETE SET NULL
);

CREATE INDEX "CsamQueueSetAside_userId_idx" ON "CsamQueueSetAside" ("userId");

-- A changed flag, or an image no longer removed, ends a set-aside: the next one is a new decision.
-- The moderation log keeps the old one. Owner's rights, so an image write never needs a grant on
-- this table.
CREATE OR REPLACE FUNCTION csam_queue_set_aside_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM "CsamQueueSetAside" WHERE "imageId" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Image_csam_queue_set_aside_end"
  AFTER UPDATE OF "needsReview", "ingestion" ON "Image"
  FOR EACH ROW
  WHEN (
    OLD."needsReview" IS DISTINCT FROM NEW."needsReview"
    OR (OLD."ingestion" = 'Blocked' AND NEW."ingestion" IS DISTINCT FROM 'Blocked')
  )
  EXECUTE FUNCTION csam_queue_set_aside_end();
COMMIT;
