-- Challenge report join table (lets users report a challenge's author-supplied text/config,
-- mirroring BountyReport). Applied manually per repo convention.

CREATE TABLE "ChallengeReport" (
  "challengeId" INTEGER NOT NULL,
  "reportId"    INTEGER NOT NULL,
  CONSTRAINT "ChallengeReport_pkey" PRIMARY KEY ("reportId", "challengeId")
);

CREATE UNIQUE INDEX "ChallengeReport_reportId_key" ON "ChallengeReport"("reportId");
CREATE INDEX "ChallengeReport_challengeId_idx" ON "ChallengeReport" USING HASH ("challengeId");

ALTER TABLE "ChallengeReport"
  ADD CONSTRAINT "ChallengeReport_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChallengeReport"
  ADD CONSTRAINT "ChallengeReport_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
