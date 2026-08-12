-- Minimal schema for the Prisma-vs-Kysely parity suite (kysely-prisma-parity.test.ts).
--
-- Only the tables the ported read queries touch, mirroring schema.full.prisma: same column names,
-- same types, same primary keys, same hash indexes. Foreign keys to Model/Image/User/Tag are
-- deliberately omitted so the suite can seed rows without materialising half the schema — the
-- queries under test never join those tables, so their absence cannot change a result.
--
-- Applied by the suite against KYSELY_PARITY_DATABASE_URL, which must be a THROWAWAY database:
-- this drops and recreates everything below on every run.

DROP TABLE IF EXISTS "TagsOnImageVote";
DROP TABLE IF EXISTS "TagsOnModelsVote";
DROP TABLE IF EXISTS "ModelEngagement";
-- Created by the array-column seam guard's positive control. Dropped here, before the enum it
-- depends on, so the suite is re-runnable against the same database.
DROP TABLE IF EXISTS "_ParityArrayProbe";
DROP TYPE IF EXISTS "ModelEngagementType";

CREATE TYPE "ModelEngagementType" AS ENUM ('Favorite', 'Hide', 'Mute', 'Notify');

CREATE TABLE "ModelEngagement" (
  "userId"    INTEGER                NOT NULL,
  "modelId"   INTEGER                NOT NULL,
  "type"      "ModelEngagementType"  NOT NULL,
  "createdAt" TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelEngagement_pkey" PRIMARY KEY ("userId", "modelId")
);
CREATE INDEX "ModelEngagement_modelId_idx" ON "ModelEngagement" USING HASH ("modelId");

CREATE TABLE "TagsOnModelsVote" (
  "modelId"   INTEGER      NOT NULL,
  "tagId"     INTEGER      NOT NULL,
  "userId"    INTEGER      NOT NULL,
  "vote"      INTEGER      NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TagsOnModelsVote_pkey" PRIMARY KEY ("tagId", "modelId", "userId")
);
CREATE INDEX "TagsOnModelsVote_modelId_idx" ON "TagsOnModelsVote" USING HASH ("modelId");
CREATE INDEX "TagsOnModelsVote_userId_idx" ON "TagsOnModelsVote" USING HASH ("userId");

CREATE TABLE "TagsOnImageVote" (
  "imageId"   INTEGER      NOT NULL,
  "tagId"     INTEGER      NOT NULL,
  "userId"    INTEGER      NOT NULL,
  "vote"      INTEGER      NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied"   BOOLEAN      NOT NULL DEFAULT false,
  CONSTRAINT "TagsOnImageVote_pkey" PRIMARY KEY ("tagId", "imageId", "userId")
);
CREATE INDEX "TagsOnImageVote_imageId_idx" ON "TagsOnImageVote" USING HASH ("imageId");
CREATE INDEX "TagsOnImageVote_userId_idx" ON "TagsOnImageVote" USING HASH ("userId");
