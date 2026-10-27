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
