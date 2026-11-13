-- Minimal schema for hot-reads-9.kysely-parity.test.ts.
--
-- Only the tables the user profile read behind kysely-hot-reads-9 touches, and only the columns it
-- selects, filters, joins or orders on. Types, nullability, keys and enums follow schema.full.prisma
-- and the migrations (every timestamp is TIMESTAMP(3), as there). Foreign keys are left out so a
-- fixture row can point at a row that is gone (a profile picture or cover image that was deleted).
-- "UserRank" is a table, as in production (the leaderboard job truncates and refills it).
-- "TagsOnImageDetails" is a VIEW over "TagsOnImageNew", copied from migration
-- 20250303170613_tags_on_image_new, so the suite can EXPLAIN how the read reaches it. Everything
-- lives in its own schema, hot_reads_9_parity, because other parity suites share the throwaway
-- database.
--
-- "User"."username" is CITEXT, as in production (unlike the older parity fixtures, which use TEXT),
-- so a case-only difference in a username lookup shows. The extension goes in "public", where
-- production has it and where the DROP SCHEMA below cannot remove it, and is created only if missing.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_9_parity" CASCADE;
CREATE SCHEMA "hot_reads_9_parity";
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

CREATE TYPE "hot_reads_9_parity"."LinkType" AS ENUM ('Sponsorship', 'Social', 'Other');
CREATE TYPE "hot_reads_9_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_9_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_9_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_9_parity"."ImageGenerationProcess" AS ENUM ('txt2img', 'txt2imgHiRes', 'img2img', 'inpainting');
CREATE TYPE "hot_reads_9_parity"."MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "hot_reads_9_parity"."TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation', 'System');
CREATE TYPE "hot_reads_9_parity"."TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive', 'MinorDetection', 'HiveDemographics', 'Clavata', 'SpineRating', 'AiRecognition', 'AnimeRecognition');

CREATE TABLE "hot_reads_9_parity"."User" (
  "id"                  INTEGER      NOT NULL PRIMARY KEY,
  "username"            public.citext UNIQUE,
  "image"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"           TIMESTAMP(3),
  "muted"               BOOLEAN      NOT NULL DEFAULT false,
  "bannedAt"            TIMESTAMP(3),
  "meta"                JSONB        DEFAULT '{}',
  "leaderboardShowcase" TEXT,
  "profilePictureId"    INTEGER      UNIQUE,
  "settings"            JSONB        DEFAULT '{}',
  "publicSettings"      JSONB        DEFAULT '{}'
);

CREATE TABLE "hot_reads_9_parity"."Image" (
  "id"                INTEGER                                         NOT NULL PRIMARY KEY,
  "name"              TEXT,
  "url"               TEXT                                            NOT NULL,
  "userId"            INTEGER                                         NOT NULL,
  "createdAt"         TIMESTAMP(3)                                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "meta"              JSONB,
  "hash"              TEXT,
  "height"            INTEGER,
  "width"             INTEGER,
  "type"              "hot_reads_9_parity"."MediaType"                NOT NULL DEFAULT 'image',
  "metadata"          JSONB                                           NOT NULL DEFAULT '{}',
  "nsfwLevel"         INTEGER                                         NOT NULL DEFAULT 0,
  "generationProcess" "hot_reads_9_parity"."ImageGenerationProcess",
  "postId"            INTEGER,
  "needsReview"       TEXT,
  "hideMeta"          BOOLEAN                                         NOT NULL DEFAULT false,
  "scannedAt"         TIMESTAMP(3),
  "ingestion"         "hot_reads_9_parity"."ImageIngestionStatus"     NOT NULL DEFAULT 'Pending',
  "blockedFor"        TEXT
);

CREATE TABLE "hot_reads_9_parity"."UserRank" (
  "userId"              INTEGER NOT NULL PRIMARY KEY,
  "leaderboardRank"     INTEGER,
  "leaderboardId"       TEXT,
  "leaderboardTitle"    TEXT,
  "leaderboardCosmetic" TEXT
);

CREATE TABLE "hot_reads_9_parity"."UserProfile" (
  "userId"                  INTEGER      NOT NULL PRIMARY KEY,
  "coverImageId"            INTEGER,
  "bio"                     TEXT,
  "message"                 TEXT,
  "messageAddedAt"          TIMESTAMP(3),
  "sfwCoverImageId"         INTEGER,
  "sfwBio"                  TEXT,
  "sfwMessage"              TEXT,
  "sfwMessageAddedAt"       TIMESTAMP(3),
  "location"                TEXT,
  "nsfw"                    BOOLEAN      NOT NULL DEFAULT false,
  "privacySettings"         JSONB        NOT NULL DEFAULT '{"showFollowerCount":true}',
  "profileSectionsSettings" JSONB        NOT NULL DEFAULT '[]',
  "showcaseItems"           JSONB        NOT NULL DEFAULT '[]',
  "showcaseSections"        JSONB        NOT NULL DEFAULT '[]'
);

CREATE TABLE "hot_reads_9_parity"."UserLink" (
  "id"     INTEGER                          NOT NULL PRIMARY KEY,
  "userId" INTEGER                          NOT NULL,
  "url"    TEXT                             NOT NULL,
  "type"   "hot_reads_9_parity"."LinkType"  NOT NULL
);

CREATE TABLE "hot_reads_9_parity"."Cosmetic" (
  "id"          INTEGER                                NOT NULL PRIMARY KEY,
  "name"        TEXT                                   NOT NULL,
  "description" TEXT,
  "videoUrl"    TEXT,
  "type"        "hot_reads_9_parity"."CosmeticType"    NOT NULL,
  "source"      "hot_reads_9_parity"."CosmeticSource"  NOT NULL,
  "data"        JSONB                                  NOT NULL
);

CREATE TABLE "hot_reads_9_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL,
  "cosmeticId"   INTEGER      NOT NULL,
  "obtainedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equippedAt"   TIMESTAMP(3),
  "data"         JSONB,
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedToId" INTEGER,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_9_parity"."Tag" (
  "id"         INTEGER                         NOT NULL PRIMARY KEY,
  "name"       TEXT                            NOT NULL UNIQUE,
  "type"       "hot_reads_9_parity"."TagType"  NOT NULL DEFAULT 'UserGenerated',
  "isCategory" BOOLEAN                         NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_9_parity"."TagsOnImageNew" (
  "imageId"    INTEGER  NOT NULL,
  "tagId"      INTEGER  NOT NULL,
  "attributes" INTEGER  NOT NULL,
  PRIMARY KEY ("imageId", "tagId")
);

CREATE VIEW "hot_reads_9_parity"."TagsOnImageDetails" AS
SELECT
  "imageId",
  "tagId",
  CASE
    WHEN (("attributes" >> 12) & 15) = 1 THEN 'User'::"hot_reads_9_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 2 THEN 'Rekognition'::"hot_reads_9_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 3 THEN 'WD14'::"hot_reads_9_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 4 THEN 'Computed'::"hot_reads_9_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 5 THEN 'ImageHash'::"hot_reads_9_parity"."TagSource"
    WHEN (("attributes" >> 12) & 15) = 6 THEN 'MinorDetection'::"hot_reads_9_parity"."TagSource"
    ELSE 'User'::"hot_reads_9_parity"."TagSource"
  END AS source,
  CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
  CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
  CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS "needsReview",
  CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
  CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
  ("attributes" & 127) AS confidence
FROM "hot_reads_9_parity"."TagsOnImageNew";
