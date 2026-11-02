-- Minimal schema for hot-reads-6.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-6 touch, and only the columns those reads
-- select, filter, join or order on. Types, nullability and primary keys follow schema.full.prisma,
-- except that the CITEXT column ("User"."username") is TEXT here, as in the other parity fixtures,
-- so the throwaway database needs no extension. Foreign keys are left out where a fixture row must
-- break one on purpose (a version whose model is gone, a post whose tag or user is gone, a profile
-- picture id pointing at no image). All of them are base TABLES in production too (none is declared
-- as a view), which the suite checks separately. Everything lives in its own schema,
-- hot_reads_6_parity, because other parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_6_parity" CASCADE;
CREATE SCHEMA "hot_reads_6_parity";

CREATE TYPE "hot_reads_6_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_6_parity"."MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "hot_reads_6_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_6_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_6_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "hot_reads_6_parity"."CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
CREATE TYPE "hot_reads_6_parity"."PaidAccessEntityType" AS ENUM ('ModelVersion', 'ComicChapter');
CREATE TYPE "hot_reads_6_parity"."ModelVersionEngagementType" AS ENUM ('Notify');
CREATE TYPE "hot_reads_6_parity"."AssociationType" AS ENUM ('Suggested');
CREATE TYPE "hot_reads_6_parity"."ModelHashType" AS ENUM ('AutoV1', 'AutoV2', 'AutoV3', 'SHA256', 'CRC32', 'BLAKE3', 'SHA256_12', 'SSHS_12');
CREATE TYPE "hot_reads_6_parity"."ModelFileVisibility" AS ENUM ('Sensitive', 'Private', 'Public');

CREATE TABLE "hot_reads_6_parity"."User" (
  "id"               INTEGER      NOT NULL PRIMARY KEY,
  "username"         TEXT,
  "image"            TEXT,
  "deletedAt"        TIMESTAMP(3),
  "bannedAt"         TIMESTAMP(3),
  "profilePictureId" INTEGER,
  "settings"         JSONB        DEFAULT '{}'
);

CREATE TABLE "hot_reads_6_parity"."Image" (
  "id"        INTEGER                                         NOT NULL PRIMARY KEY,
  "name"      TEXT,
  "url"       TEXT                                            NOT NULL,
  "nsfwLevel" INTEGER                                         NOT NULL DEFAULT 0,
  "hash"      TEXT,
  "userId"    INTEGER                                         NOT NULL,
  "ingestion" "hot_reads_6_parity"."ImageIngestionStatus"     NOT NULL DEFAULT 'Pending',
  "type"      "hot_reads_6_parity"."MediaType"                NOT NULL DEFAULT 'image',
  "width"     INTEGER,
  "height"    INTEGER,
  "metadata"  JSONB                                           NOT NULL DEFAULT '{}'
);

CREATE TABLE "hot_reads_6_parity"."Cosmetic" (
  "id"     INTEGER                                  NOT NULL PRIMARY KEY,
  "name"   TEXT                                     NOT NULL,
  "type"   "hot_reads_6_parity"."CosmeticType"      NOT NULL,
  "source" "hot_reads_6_parity"."CosmeticSource"    NOT NULL,
  "data"   JSONB                                    NOT NULL
);

CREATE TABLE "hot_reads_6_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL,
  "cosmeticId"   INTEGER      NOT NULL,
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedAt"   TIMESTAMP(3),
  "equippedToId" INTEGER,
  "data"         JSONB,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_6_parity"."Model" (
  "id"     INTEGER NOT NULL PRIMARY KEY,
  "poi"    BOOLEAN NOT NULL DEFAULT false,
  "userId" INTEGER NOT NULL,
  "meta"   JSONB   NOT NULL DEFAULT '{}'
);

CREATE TABLE "hot_reads_6_parity"."ModelVersion" (
  "id"          INTEGER      NOT NULL PRIMARY KEY,
  "modelId"     INTEGER      NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "meta"        JSONB        NOT NULL DEFAULT '{}'
);

CREATE TABLE "hot_reads_6_parity"."Collection" (
  "id" INTEGER NOT NULL PRIMARY KEY
);

CREATE TABLE "hot_reads_6_parity"."CollectionContributor" (
  "userId"       INTEGER                                                   NOT NULL,
  "collectionId" INTEGER                                                   NOT NULL,
  "permissions"  "hot_reads_6_parity"."CollectionContributorPermission"[] NOT NULL,
  PRIMARY KEY ("userId", "collectionId")
);

CREATE TABLE "hot_reads_6_parity"."Post" (
  "id"             INTEGER                                 NOT NULL PRIMARY KEY,
  "nsfw"           BOOLEAN                                 NOT NULL DEFAULT false,
  "nsfwLevel"      INTEGER                                 NOT NULL DEFAULT 0,
  "title"          TEXT,
  "detail"         TEXT,
  "modelVersionId" INTEGER,
  "userId"         INTEGER                                 NOT NULL,
  "publishedAt"    TIMESTAMP(3),
  "availability"   "hot_reads_6_parity"."Availability"     NOT NULL DEFAULT 'Public',
  "collectionId"   INTEGER
);

CREATE TABLE "hot_reads_6_parity"."Tag" (
  "id"         INTEGER NOT NULL PRIMARY KEY,
  "name"       TEXT    NOT NULL,
  "isCategory" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_6_parity"."TagsOnPost" (
  "postId" INTEGER NOT NULL,
  "tagId"  INTEGER NOT NULL,
  PRIMARY KEY ("tagId", "postId")
);

CREATE TABLE "hot_reads_6_parity"."DonationGoal" (
  "id"          INTEGER                                      NOT NULL PRIMARY KEY,
  "userId"      INTEGER                                      NOT NULL,
  "title"       TEXT                                         NOT NULL,
  "description" TEXT,
  "goalAmount"  INTEGER                                      NOT NULL,
  "entityType"  "hot_reads_6_parity"."PaidAccessEntityType",
  "entityId"    INTEGER,
  "createdAt"   TIMESTAMP(3)                                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active"      BOOLEAN                                      NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_6_parity"."ModelVersionEngagement" (
  "userId"         INTEGER                                            NOT NULL,
  "modelVersionId" INTEGER                                            NOT NULL,
  "type"           "hot_reads_6_parity"."ModelVersionEngagementType" NOT NULL,
  PRIMARY KEY ("userId", "modelVersionId")
);

CREATE TABLE "hot_reads_6_parity"."ModelAssociations" (
  "id"          INTEGER                                 NOT NULL PRIMARY KEY,
  "fromModelId" INTEGER                                 NOT NULL,
  "toModelId"   INTEGER,
  "toArticleId" INTEGER,
  "type"        "hot_reads_6_parity"."AssociationType"  NOT NULL,
  "index"       INTEGER
);

CREATE TABLE "hot_reads_6_parity"."ResourceReview" (
  "id"             INTEGER NOT NULL PRIMARY KEY,
  "modelId"        INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL,
  "userId"         INTEGER NOT NULL,
  "recommended"    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "hot_reads_6_parity"."ModelFile" (
  "id"             INTEGER                                     NOT NULL PRIMARY KEY,
  "name"           TEXT                                        NOT NULL,
  "overrideName"   TEXT,
  "url"            TEXT                                        NOT NULL,
  "sizeKB"         DOUBLE PRECISION                            NOT NULL,
  "type"           TEXT                                        NOT NULL DEFAULT 'Model',
  "modelVersionId" INTEGER                                     NOT NULL,
  "metadata"       JSONB,
  "visibility"     "hot_reads_6_parity"."ModelFileVisibility" NOT NULL DEFAULT 'Public',
  "replacedAt"     TIMESTAMP(3)
);

CREATE TABLE "hot_reads_6_parity"."ModelFileHash" (
  "fileId" INTEGER                                NOT NULL,
  "type"   "hot_reads_6_parity"."ModelHashType"   NOT NULL,
  "hash"   TEXT                                   NOT NULL,
  PRIMARY KEY ("fileId", "type")
);
