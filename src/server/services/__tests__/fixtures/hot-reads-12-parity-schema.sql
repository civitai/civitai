-- Minimal schema for hot-reads-12.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-12 touch, and only the columns they select,
-- filter, join or order on. Types, nullability, keys and enums follow schema.full.prisma and the
-- migrations (every timestamp is TIMESTAMP(3), as there). Foreign keys are left out so a fixture row
-- can point at a row that is gone (a profile picture that was deleted). Everything lives in its own
-- schema, hot_reads_12_parity, because other parity suites share the throwaway database.
--
-- "User"."username" and "Model"."name" are CITEXT, as in production. The extension goes in
-- "public", where production has it and where the DROP SCHEMA below cannot remove it, and is
-- created only if missing.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_12_parity" CASCADE;
CREATE SCHEMA "hot_reads_12_parity";
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

CREATE TYPE "hot_reads_12_parity"."ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "hot_reads_12_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_12_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_12_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_12_parity"."MediaType" AS ENUM ('image', 'video', 'audio');

CREATE TABLE "hot_reads_12_parity"."User" (
  "id"               INTEGER       NOT NULL PRIMARY KEY,
  "username"         public.citext UNIQUE,
  "image"            TEXT,
  "deletedAt"        TIMESTAMP(3),
  "profilePictureId" INTEGER       UNIQUE
);

CREATE TABLE "hot_reads_12_parity"."Image" (
  "id"          INTEGER                                       NOT NULL PRIMARY KEY,
  "name"        TEXT,
  "url"         TEXT                                          NOT NULL,
  "userId"      INTEGER                                       NOT NULL,
  "hash"        TEXT,
  "height"      INTEGER,
  "width"       INTEGER,
  "type"        "hot_reads_12_parity"."MediaType"             NOT NULL DEFAULT 'image',
  "metadata"    JSONB                                         NOT NULL DEFAULT '{}',
  "nsfwLevel"   INTEGER                                       NOT NULL DEFAULT 0,
  "needsReview" TEXT,
  "ingestion"   "hot_reads_12_parity"."ImageIngestionStatus"  NOT NULL DEFAULT 'Pending'
);

CREATE TABLE "hot_reads_12_parity"."Cosmetic" (
  "id"     INTEGER                                 NOT NULL PRIMARY KEY,
  "name"   TEXT                                    NOT NULL,
  "type"   "hot_reads_12_parity"."CosmeticType"    NOT NULL,
  "source" "hot_reads_12_parity"."CosmeticSource"  NOT NULL,
  "data"   JSONB                                   NOT NULL
);

CREATE TABLE "hot_reads_12_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL,
  "cosmeticId"   INTEGER      NOT NULL,
  "obtainedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equippedAt"   TIMESTAMP(3),
  "data"         JSONB,
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedToId" INTEGER,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_12_parity"."Model" (
  "id"        INTEGER                               NOT NULL PRIMARY KEY,
  "name"      public.citext                         NOT NULL,
  "createdAt" TIMESTAMP(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"    INTEGER                               NOT NULL,
  "status"    "hot_reads_12_parity"."ModelStatus"   NOT NULL DEFAULT 'Draft',
  "locked"    BOOLEAN                               NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_12_parity"."ModelVersion" (
  "id"   INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT    NOT NULL
);

CREATE TABLE "hot_reads_12_parity"."ResourceReview" (
  "id"             INTEGER      NOT NULL PRIMARY KEY,
  "modelId"        INTEGER      NOT NULL,
  "modelVersionId" INTEGER      NOT NULL,
  "rating"         INTEGER      NOT NULL,
  "recommended"    BOOLEAN      NOT NULL DEFAULT true,
  "details"        TEXT,
  "userId"         INTEGER      NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
