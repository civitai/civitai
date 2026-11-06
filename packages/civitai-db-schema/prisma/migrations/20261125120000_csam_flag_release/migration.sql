-- One row per admin release of a held user's removed-image review flags. The release refuses while
-- this table is missing, so apply it BEFORE deploying the moderator build that writes it.

CREATE TABLE "CsamFlagRelease" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "moderatorId" INTEGER NOT NULL,
  "approvalRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "overriddenLegs" JSONB NOT NULL,
  "imageCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "CsamFlagRelease_userId_idx" ON "CsamFlagRelease" ("userId");
