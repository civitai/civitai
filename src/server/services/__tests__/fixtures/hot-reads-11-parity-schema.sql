-- Minimal schema for hot-reads-11.kysely-parity.test.ts.
--
-- Only the tables the four reads behind kysely-hot-reads-11 touch. "ModelMetric" and
-- "ModelVersionMetric" carry EVERY column of the Prisma model, because the Prisma reads have no
-- select and so name every column. "ModelVersion" and "RecommendedResource" carry only the columns
-- the reads select or filter on. Types, nullability, keys and enums follow schema.full.prisma and
-- the migrations (every timestamp is TIMESTAMP(3), as there). Foreign keys are left out so a
-- fixture row can point at a version that is not there. Everything lives in its own schema,
-- hot_reads_11_parity, because other parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_11_parity" CASCADE;
CREATE SCHEMA "hot_reads_11_parity";

CREATE TYPE "hot_reads_11_parity"."ModelModifier" AS ENUM ('Archived', 'TakenDown');
CREATE TYPE "hot_reads_11_parity"."ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "hot_reads_11_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');

CREATE TABLE "hot_reads_11_parity"."ModelMetric" (
  "modelId"              INTEGER                                NOT NULL PRIMARY KEY,
  "downloadCount"        INTEGER                                NOT NULL DEFAULT 0,
  "commentCount"         INTEGER                                NOT NULL DEFAULT 0,
  "collectedCount"       INTEGER                                NOT NULL DEFAULT 0,
  "imageCount"           INTEGER                                NOT NULL DEFAULT 0,
  "tippedCount"          INTEGER                                NOT NULL DEFAULT 0,
  "tippedAmountCount"    INTEGER                                NOT NULL DEFAULT 0,
  "generationCount"      INTEGER                                NOT NULL DEFAULT 0,
  "thumbsUpCount"        INTEGER                                NOT NULL DEFAULT 0,
  "thumbsDownCount"      INTEGER                                NOT NULL DEFAULT 0,
  "earnedAmount"         INTEGER                                NOT NULL DEFAULT 0,
  "updatedAt"            TIMESTAMP(3)                           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "poi"                  BOOLEAN                                NOT NULL DEFAULT false,
  "minor"                BOOLEAN                                NOT NULL DEFAULT false,
  "nsfwLevel"            INTEGER                                NOT NULL DEFAULT 0,
  "userId"               INTEGER                                NOT NULL DEFAULT 0,
  "lastVersionAt"        TIMESTAMP(3),
  "publishedAt"          TIMESTAMP(3),
  "mode"                 "hot_reads_11_parity"."ModelModifier",
  "status"               "hot_reads_11_parity"."ModelStatus"    NOT NULL DEFAULT 'Draft',
  "availability"         "hot_reads_11_parity"."Availability"   NOT NULL DEFAULT 'Public',
  "hotScore"             INTEGER,
  "uniqueGeneratorCount" INTEGER                                NOT NULL DEFAULT 0
);

CREATE TABLE "hot_reads_11_parity"."ModelVersionMetric" (
  "modelVersionId"    INTEGER      NOT NULL PRIMARY KEY,
  "downloadCount"     INTEGER      NOT NULL DEFAULT 0,
  "commentCount"      INTEGER      NOT NULL DEFAULT 0,
  "collectedCount"    INTEGER      NOT NULL DEFAULT 0,
  "imageCount"        INTEGER      NOT NULL DEFAULT 0,
  "tippedCount"       INTEGER      NOT NULL DEFAULT 0,
  "tippedAmountCount" INTEGER      NOT NULL DEFAULT 0,
  "generationCount"   INTEGER      NOT NULL DEFAULT 0,
  "thumbsUpCount"     INTEGER      NOT NULL DEFAULT 0,
  "thumbsDownCount"   INTEGER      NOT NULL DEFAULT 0,
  "earnedAmount"      INTEGER      NOT NULL DEFAULT 0,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "hot_reads_11_parity"."ModelVersion" (
  "id"   INTEGER NOT NULL PRIMARY KEY,
  "meta" JSONB   NOT NULL DEFAULT '{}'
);

CREATE TABLE "hot_reads_11_parity"."RecommendedResource" (
  "id"         INTEGER NOT NULL PRIMARY KEY,
  "resourceId" INTEGER NOT NULL,
  "sourceId"   INTEGER,
  "settings"   JSONB
);

CREATE INDEX "RecommendedResource_sourceId_idx" ON "hot_reads_11_parity"."RecommendedResource" USING HASH ("sourceId");
