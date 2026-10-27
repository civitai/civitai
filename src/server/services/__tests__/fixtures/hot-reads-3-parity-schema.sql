-- Minimal schema for hot-reads-3.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-3 touch, and only the columns those reads select,
-- filter or order on. Types, nullability and primary keys follow schema.full.prisma. All of them are
-- base TABLES in production too (none is declared as a view), which the suite checks separately.
-- Everything lives in its own schema, hot_reads_3_parity, because other parity suites share the
-- throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_3_parity" CASCADE;
CREATE SCHEMA "hot_reads_3_parity";

CREATE TYPE "hot_reads_3_parity"."ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "hot_reads_3_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "hot_reads_3_parity"."TrainingStatus" AS ENUM ('Pending', 'Submitted', 'Paused', 'Denied', 'Processing', 'InReview', 'Failed', 'Approved', 'Expired');
CREATE TYPE "hot_reads_3_parity"."AssociationType" AS ENUM ('Suggested');

CREATE TABLE "hot_reads_3_parity"."User" (
  "id"       INTEGER NOT NULL PRIMARY KEY,
  "settings" JSONB   DEFAULT '{}'
);

CREATE TABLE "hot_reads_3_parity"."Model" (
  "id"           INTEGER                              NOT NULL PRIMARY KEY,
  "userId"       INTEGER                              NOT NULL,
  "status"       "hot_reads_3_parity"."ModelStatus"   NOT NULL DEFAULT 'Draft',
  "availability" "hot_reads_3_parity"."Availability"  NOT NULL DEFAULT 'Public'
);

CREATE TABLE "hot_reads_3_parity"."ModelVersion" (
  "id"             INTEGER                               NOT NULL PRIMARY KEY,
  "index"          INTEGER,
  "modelId"        INTEGER                               NOT NULL,
  "publishedAt"    TIMESTAMP(3),
  "status"         "hot_reads_3_parity"."ModelStatus"    NOT NULL DEFAULT 'Draft',
  "trainingStatus" "hot_reads_3_parity"."TrainingStatus",
  "availability"   "hot_reads_3_parity"."Availability"   NOT NULL DEFAULT 'Public'
);

CREATE TABLE "hot_reads_3_parity"."ModelAssociations" (
  "id"          INTEGER                                 NOT NULL PRIMARY KEY,
  "fromModelId" INTEGER                                 NOT NULL,
  "toModelId"   INTEGER,
  "type"        "hot_reads_3_parity"."AssociationType"  NOT NULL
);

CREATE TABLE "hot_reads_3_parity"."Post" (
  "id"             INTEGER NOT NULL PRIMARY KEY,
  "userId"         INTEGER NOT NULL,
  "modelVersionId" INTEGER
);

CREATE TABLE "hot_reads_3_parity"."Placement" (
  "id"         INTEGER      NOT NULL PRIMARY KEY,
  "surface"    TEXT         NOT NULL,
  "targetType" TEXT         NOT NULL,
  "targetId"   INTEGER      NOT NULL,
  "ownerId"    INTEGER      NOT NULL,
  "placerId"   INTEGER      NOT NULL,
  "data"       JSONB        NOT NULL DEFAULT '{}',
  "status"     TEXT         NOT NULL,
  "amount"     INTEGER      NOT NULL,
  "free"       BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3)
);
