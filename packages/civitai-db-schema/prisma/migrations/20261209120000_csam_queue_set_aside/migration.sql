-- Images a moderator took out of the CSAM review queue without changing the image itself. Apply it
-- BEFORE deploying the code that writes it (reads skip the table while it is missing). Applied
-- MANUALLY, per environment. The foreign keys keep a row from outliving its image or naming a report
-- that does not exist; the queue decides when it reads whether a row still counts.
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

-- A changed flag ends a set-aside: the image left the queue or came back to it, so the next set-aside
-- is a new decision. The moderation log keeps the old one.
CREATE OR REPLACE FUNCTION csam_queue_set_aside_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "CsamQueueSetAside" WHERE "imageId" = NEW."id";
  RETURN NULL;
END;
$$;

-- lock_timeout because CREATE TRIGGER locks "Image" against writes: better to fail fast than to queue
-- behind a long transaction and block every write to the table.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TRIGGER "Image_csam_queue_set_aside_end"
  AFTER UPDATE OF "needsReview" ON "Image"
  FOR EACH ROW
  WHEN (OLD."needsReview" IS DISTINCT FROM NEW."needsReview")
  EXECUTE FUNCTION csam_queue_set_aside_end();
COMMIT;
