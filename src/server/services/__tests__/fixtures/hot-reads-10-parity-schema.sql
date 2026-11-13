-- Minimal schema for hot-reads-10.kysely-parity.test.ts.
--
-- Only the tables the collection read behind kysely-hot-reads-10 touches, and only the columns it
-- selects, filters, joins or orders on. Types, nullability, keys and enums follow schema.full.prisma
-- and the migrations (every timestamp is TIMESTAMP(3), as there). Foreign keys are left out so a
-- fixture row can point at a row that is gone (a cover image or profile picture that was deleted).
-- "TagsOnImageDetails" is a VIEW over "TagsOnImageNew", copied from migration
-- 20250303170613_tags_on_image_new, so the suite can EXPLAIN how the read reaches it. Everything
-- lives in its own schema, hot_reads_10_parity, because other parity suites share the throwaway
-- database.
--
-- "User"."username" and "Tag"."name" are CITEXT, as in production. The extension goes in "public",
-- where production has it and where the DROP SCHEMA below cannot remove it, and is created only if
-- missing.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_10_parity" CASCADE;
CREATE SCHEMA "hot_reads_10_parity";
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

CREATE TYPE "hot_reads_10_parity"."CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
CREATE TYPE "hot_reads_10_parity"."CollectionWriteConfiguration" AS ENUM ('Private', 'Public', 'Review');
CREATE TYPE "hot_reads_10_parity"."CollectionType" AS ENUM ('Model', 'Article', 'Post', 'Image', 'Model3D');
CREATE TYPE "hot_reads_10_parity"."CollectionMode" AS ENUM ('Contest', 'Bookmark');
CREATE TYPE "hot_reads_10_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "hot_reads_10_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_10_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_10_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_10_parity"."ImageGenerationProcess" AS ENUM ('txt2img', 'txt2imgHiRes', 'img2img', 'inpainting');
CREATE TYPE "hot_reads_10_parity"."MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "hot_reads_10_parity"."TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation', 'System');
CREATE TYPE "hot_reads_10_parity"."TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive', 'MinorDetection', 'HiveDemographics', 'Clavata', 'SpineRating', 'AiRecognition', 'AnimeRecognition');

CREATE TABLE "hot_reads_10_parity"."Collection" (
  "id"           INTEGER                                              NOT NULL PRIMARY KEY,
  "name"         TEXT                                                 NOT NULL,
  "description"  TEXT,
  "nsfw"         BOOLEAN                                              DEFAULT false,
  "userId"       INTEGER                                              NOT NULL,
  "imageId"      INTEGER,
  "write"        "hot_reads_10_parity"."CollectionWriteConfiguration" NOT NULL DEFAULT 'Private',
  "read"         "hot_reads_10_parity"."CollectionReadConfiguration"  NOT NULL DEFAULT 'Private',
  "type"         "hot_reads_10_parity"."CollectionType",
  "mode"         "hot_reads_10_parity"."CollectionMode",
  "metadata"     JSONB                                                NOT NULL DEFAULT '{}',
  "availability" "hot_reads_10_parity"."Availability"                 NOT NULL DEFAULT 'Public',
  "nsfwLevel"    INTEGER                                              NOT NULL DEFAULT 0,
  "archivedAt"   TIMESTAMP(3)
);

CREATE TABLE "hot_reads_10_parity"."TagsOnCollection" (
  "collectionId"   INTEGER NOT NULL,
  "tagId"          INTEGER NOT NULL,
  "filterableOnly" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tagId", "collectionId")
);

CREATE TABLE "hot_reads_10_parity"."User" (
  "id"               INTEGER       NOT NULL PRIMARY KEY,
  "username"         public.citext UNIQUE,
  "image"            TEXT,
  "deletedAt"        TIMESTAMP(3),
  "profilePictureId" INTEGER       UNIQUE
);

CREATE TABLE "hot_reads_10_parity"."Image" (
  "id"                INTEGER                                          NOT NULL PRIMARY KEY,
  "name"              TEXT,
  "url"               TEXT                                             NOT NULL,
  "userId"            INTEGER                                          NOT NULL,
  "createdAt"         TIMESTAMP(3)                                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "meta"              JSONB,
  "hash"              TEXT,
  "height"            INTEGER,
  "width"             INTEGER,
  "type"              "hot_reads_10_parity"."MediaType"                NOT NULL DEFAULT 'image',
  "metadata"          JSONB                                            NOT NULL DEFAULT '{}',
  "nsfwLevel"         INTEGER                                          NOT NULL DEFAULT 0,
  "generationProcess" "hot_reads_10_parity"."ImageGenerationProcess",
  "postId"            INTEGER,
  "needsReview"       TEXT,
  "hideMeta"          BOOLEAN                                          NOT NULL DEFAULT false,
  "scannedAt"         TIMESTAMP(3),
  "ingestion"         "hot_reads_10_parity"."ImageIngestionStatus"     NOT NULL DEFAULT 'Pending',
  "blockedFor"        TEXT
);

CREATE TABLE "hot_reads_10_parity"."Cosmetic" (
  "id"     INTEGER                                 NOT NULL PRIMARY KEY,
  "name"   TEXT                                    NOT NULL,
  "type"   "hot_reads_10_parity"."CosmeticType"    NOT NULL,
  "source" "hot_reads_10_parity"."CosmeticSource"  NOT NULL,
  "data"   JSONB                                   NOT NULL
);

CREATE TABLE "hot_reads_10_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL,
  "cosmeticId"   INTEGER      NOT NULL,
  "obtainedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equippedAt"   TIMESTAMP(3),
  "data"         JSONB,
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedToId" INTEGER,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_10_parity"."Tag" (
  "id"         INTEGER                          NOT NULL PRIMARY KEY,
  "name"       public.citext                    NOT NULL UNIQUE,
  "type"       "hot_reads_10_parity"."TagType"  NOT NULL DEFAULT 'UserGenerated',
  "isCategory" BOOLEAN                          NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_10_parity"."TagsOnImageNew" (
  "imageId"    INTEGER  NOT NULL,
  "tagId"      INTEGER  NOT NULL,
  "attributes" INTEGER  NOT NULL,
  PRIMARY KEY ("imageId", "tagId")
);

CREATE VIEW "hot_reads_10_parity"."TagsOnImageDetails" AS
SELECT
  "imageId",
  "tagId",
  CASE
    WHEN (("attributes" >> 12) & 15) = 1 THEN 'User'::"hot_reads_10_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 2 THEN 'Rekognition'::"hot_reads_10_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 3 THEN 'WD14'::"hot_reads_10_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 4 THEN 'Computed'::"hot_reads_10_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 5 THEN 'ImageHash'::"hot_reads_10_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 6 THEN 'MinorDetection'::"hot_reads_10_parity"."TagSource"
    ELSE 'User'::"hot_reads_10_parity"."TagSource"
  END AS source,
  CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
  CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
  CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS "needsReview",
  CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
  CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
  ("attributes" & 127) AS confidence
FROM "hot_reads_10_parity"."TagsOnImageNew";
