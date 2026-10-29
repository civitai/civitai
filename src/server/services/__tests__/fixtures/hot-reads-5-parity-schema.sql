-- Minimal schema for hot-reads-5.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-5 touch (and the user columns the collaborator
-- read's Prisma user select reads), and only the columns those reads select, filter, join or order
-- on. Types, nullability and primary keys follow schema.full.prisma, except that the CITEXT columns
-- ("User"."username", "Model"."name") are TEXT here, as in the other parity fixtures, so the
-- throwaway database needs no extension. Foreign keys are left out where a fixture row must break
-- one on purpose ("ModelVersion"."modelId" for an orphaned version, "Post"."model3dId" for a link
-- to no row). All of them are base TABLES in production too (none is declared as a view), which the
-- suite checks separately. Everything lives in its own schema, hot_reads_5_parity, because other
-- parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_5_parity" CASCADE;
CREATE SCHEMA "hot_reads_5_parity";

CREATE TYPE "hot_reads_5_parity"."Model3DStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'Deleted');
CREATE TYPE "hot_reads_5_parity"."EntityType" AS ENUM ('Image', 'Post', 'Article', 'Bounty', 'BountyEntry', 'ModelVersion', 'Model', 'Collection', 'Comment', 'CommentV2', 'CommentV3', 'User', 'UserProfile', 'ResourceReview', 'ChatMessage', 'Model3D', 'Storyline');
CREATE TYPE "hot_reads_5_parity"."EntityCollaboratorStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TYPE "hot_reads_5_parity"."HomeBlockType" AS ENUM ('Collection', 'Announcement', 'Leaderboard', 'Social', 'Event', 'CosmeticShop', 'FeaturedModelVersion', 'FeaturedCollections', 'Feed');
CREATE TYPE "hot_reads_5_parity"."ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "hot_reads_5_parity"."ModelType" AS ENUM ('Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA', 'LoCon', 'DoRA', 'Controlnet', 'Upscaler', 'MotionModule', 'VAE', 'TextEncoder', 'UNet', 'CLIPVision', 'Poses', 'Wildcards', 'Workflows', 'ComfyWorkflows', 'Detection', 'VisionLanguage', 'CLIP', 'LLM', 'Other');
CREATE TYPE "hot_reads_5_parity"."ModelModifier" AS ENUM ('Archived', 'TakenDown');
CREATE TYPE "hot_reads_5_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "hot_reads_5_parity"."ModelUsageControl" AS ENUM ('Download', 'Generation', 'InternalGeneration', 'ExternalGeneration');
CREATE TYPE "hot_reads_5_parity"."ReviewReactions" AS ENUM ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart');
CREATE TYPE "hot_reads_5_parity"."DomainColor" AS ENUM ('red', 'green', 'blue', 'all');
CREATE TYPE "hot_reads_5_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_5_parity"."MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "hot_reads_5_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_5_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');

CREATE TABLE "hot_reads_5_parity"."KeyValue" (
  "key"   TEXT  NOT NULL PRIMARY KEY,
  "value" JSONB NOT NULL
);

CREATE TABLE "hot_reads_5_parity"."User" (
  "id"               INTEGER      NOT NULL PRIMARY KEY,
  "username"         TEXT,
  "image"            TEXT,
  "deletedAt"        TIMESTAMP(3),
  "profilePictureId" INTEGER
);

CREATE TABLE "hot_reads_5_parity"."Model3D" (
  "id"        INTEGER                                  NOT NULL PRIMARY KEY,
  "userId"    INTEGER                                  NOT NULL,
  "status"    "hot_reads_5_parity"."Model3DStatus"     NOT NULL DEFAULT 'Draft',
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "hot_reads_5_parity"."Post" (
  "id"        INTEGER NOT NULL PRIMARY KEY,
  "userId"    INTEGER NOT NULL,
  "model3dId" INTEGER
);

CREATE TABLE "hot_reads_5_parity"."Image" (
  "id"        INTEGER                                       NOT NULL PRIMARY KEY,
  "name"      TEXT,
  "url"       TEXT                                          NOT NULL,
  "nsfwLevel" INTEGER                                       NOT NULL DEFAULT 0,
  "hash"      TEXT,
  "userId"    INTEGER                                       NOT NULL,
  "ingestion" "hot_reads_5_parity"."ImageIngestionStatus"   NOT NULL DEFAULT 'Pending',
  "type"      "hot_reads_5_parity"."MediaType"              NOT NULL DEFAULT 'image',
  "width"     INTEGER,
  "height"    INTEGER,
  "metadata"  JSONB                                         NOT NULL DEFAULT '{}',
  "postId"    INTEGER
);

CREATE TABLE "hot_reads_5_parity"."Cosmetic" (
  "id"     INTEGER                                 NOT NULL PRIMARY KEY,
  "name"   TEXT                                    NOT NULL,
  "type"   "hot_reads_5_parity"."CosmeticType"     NOT NULL,
  "source" "hot_reads_5_parity"."CosmeticSource"   NOT NULL,
  "data"   JSONB                                   NOT NULL
);

CREATE TABLE "hot_reads_5_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL REFERENCES "hot_reads_5_parity"."User" ("id"),
  "cosmeticId"   INTEGER      NOT NULL REFERENCES "hot_reads_5_parity"."Cosmetic" ("id"),
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedAt"   TIMESTAMP(3),
  "equippedToId" INTEGER,
  "data"         JSONB,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_5_parity"."Announcement" (
  "id"       INTEGER                                  NOT NULL PRIMARY KEY,
  "disabled" BOOLEAN                                  NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3),
  "endsAt"   TIMESTAMP(3),
  "domain"   "hot_reads_5_parity"."DomainColor"[]     NOT NULL DEFAULT ARRAY['all']::"hot_reads_5_parity"."DomainColor"[]
);

CREATE TABLE "hot_reads_5_parity"."AnnouncementDismissal" (
  "announcementId" INTEGER NOT NULL REFERENCES "hot_reads_5_parity"."Announcement" ("id"),
  "userId"         INTEGER NOT NULL,
  PRIMARY KEY ("userId", "announcementId")
);

CREATE TABLE "hot_reads_5_parity"."EntityCollaborator" (
  "entityType" "hot_reads_5_parity"."EntityType"                NOT NULL,
  "entityId"   INTEGER                                          NOT NULL,
  "userId"     INTEGER                                          NOT NULL REFERENCES "hot_reads_5_parity"."User" ("id"),
  "status"     "hot_reads_5_parity"."EntityCollaboratorStatus"  NOT NULL DEFAULT 'Pending',
  PRIMARY KEY ("entityType", "entityId", "userId")
);

CREATE TABLE "hot_reads_5_parity"."HomeBlock" (
  "id"       INTEGER                                  NOT NULL PRIMARY KEY,
  "userId"   INTEGER                                  NOT NULL,
  "metadata" JSONB                                    NOT NULL DEFAULT '{}',
  "type"     "hot_reads_5_parity"."HomeBlockType"     NOT NULL,
  "sourceId" INTEGER
);

CREATE TABLE "hot_reads_5_parity"."Prize" (
  "id"        INTEGER      NOT NULL PRIMARY KEY,
  "userId"    INTEGER      NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "voidedAt"  TIMESTAMP(3)
);

CREATE TABLE "hot_reads_5_parity"."Model" (
  "id"           INTEGER                                  NOT NULL PRIMARY KEY,
  "name"         TEXT                                     NOT NULL,
  "type"         "hot_reads_5_parity"."ModelType"         NOT NULL,
  "nsfw"         BOOLEAN                                  NOT NULL DEFAULT false,
  "poi"          BOOLEAN                                  NOT NULL DEFAULT false,
  "userId"       INTEGER                                  NOT NULL,
  "status"       "hot_reads_5_parity"."ModelStatus"       NOT NULL DEFAULT 'Draft',
  "publishedAt"  TIMESTAMP(3),
  "meta"         JSONB                                    NOT NULL DEFAULT '{}',
  "mode"         "hot_reads_5_parity"."ModelModifier",
  "availability" "hot_reads_5_parity"."Availability"      NOT NULL DEFAULT 'Public'
);

CREATE TABLE "hot_reads_5_parity"."ModelVersion" (
  "id"           INTEGER                                      NOT NULL PRIMARY KEY,
  "name"         TEXT                                         NOT NULL,
  "modelId"      INTEGER                                      NOT NULL,
  "trainedWords" TEXT[],
  "createdAt"    TIMESTAMP(3)                                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"       "hot_reads_5_parity"."ModelStatus"           NOT NULL DEFAULT 'Draft',
  "requireAuth"  BOOLEAN                                      NOT NULL DEFAULT false,
  "usageControl" "hot_reads_5_parity"."ModelUsageControl"     NOT NULL DEFAULT 'Download'
);

CREATE TABLE "hot_reads_5_parity"."ResourceReview" (
  "id"             INTEGER      NOT NULL PRIMARY KEY,
  "modelId"        INTEGER      NOT NULL,
  "modelVersionId" INTEGER      NOT NULL,
  "userId"         INTEGER      NOT NULL,
  "recommended"    BOOLEAN      NOT NULL DEFAULT true,
  "details"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exclude"        BOOLEAN      NOT NULL DEFAULT false
);

CREATE TABLE "hot_reads_5_parity"."ImageReaction" (
  "id"       INTEGER                                  NOT NULL PRIMARY KEY,
  "imageId"  INTEGER                                  NOT NULL,
  "userId"   INTEGER                                  NOT NULL,
  "reaction" "hot_reads_5_parity"."ReviewReactions"   NOT NULL
);
