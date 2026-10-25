-- Minimal schema for hot-reads-2.kysely-parity.test.ts.
--
-- Only the tables the model-page and creator-card reads touch, and only the columns those reads
-- select or filter on. Types, nullability and primary keys follow schema.full.prisma. Everything
-- lives in its own schema, hot_reads_2_parity, because other parity suites share the throwaway
-- database. CITEXT columns ("User"."username", "Model"."name", "ModelFileHash"."hash") are TEXT
-- here, so the suite needs no extension. Both paths read them back as plain strings.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_2_parity" CASCADE;
CREATE SCHEMA "hot_reads_2_parity";

CREATE TYPE "hot_reads_2_parity"."ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "hot_reads_2_parity"."ModelType" AS ENUM ('Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA', 'LoCon', 'DoRA', 'Controlnet', 'Upscaler', 'MotionModule', 'VAE', 'TextEncoder', 'UNet', 'CLIPVision', 'Poses', 'Wildcards', 'Workflows', 'ComfyWorkflows', 'Detection', 'VisionLanguage', 'CLIP', 'LLM', 'Other');
CREATE TYPE "hot_reads_2_parity"."ModelUploadType" AS ENUM ('Created', 'Trained');
CREATE TYPE "hot_reads_2_parity"."CheckpointType" AS ENUM ('Trained', 'Merge');
CREATE TYPE "hot_reads_2_parity"."CommercialUse" AS ENUM ('None', 'Image', 'RentCivit', 'Rent', 'Sell', 'SellMerge');
CREATE TYPE "hot_reads_2_parity"."ModelModifier" AS ENUM ('Archived', 'TakenDown');
CREATE TYPE "hot_reads_2_parity"."Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "hot_reads_2_parity"."TrainingStatus" AS ENUM ('Pending', 'Submitted', 'Paused', 'Denied', 'Processing', 'InReview', 'Failed', 'Approved', 'Expired');
CREATE TYPE "hot_reads_2_parity"."ModelUsageControl" AS ENUM ('Download', 'Generation', 'InternalGeneration', 'ExternalGeneration');
CREATE TYPE "hot_reads_2_parity"."ScanResultCode" AS ENUM ('Pending', 'Success', 'Danger', 'Error');
CREATE TYPE "hot_reads_2_parity"."ModelFileVisibility" AS ENUM ('Sensitive', 'Private', 'Public');
CREATE TYPE "hot_reads_2_parity"."ModelHashType" AS ENUM ('AutoV1', 'AutoV2', 'AutoV3', 'SHA256', 'CRC32', 'BLAKE3', 'SHA256_12', 'SSHS_12');
CREATE TYPE "hot_reads_2_parity"."LinkType" AS ENUM ('Sponsorship', 'Social', 'Other');
CREATE TYPE "hot_reads_2_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_2_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_2_parity"."ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "hot_reads_2_parity"."MediaType" AS ENUM ('image', 'video', 'audio');

CREATE TABLE "hot_reads_2_parity"."User" (
  "id"                      INTEGER      NOT NULL PRIMARY KEY,
  "username"                TEXT,
  "image"                   TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"               TIMESTAMP(3),
  "muted"                   BOOLEAN      NOT NULL DEFAULT false,
  "bannedAt"                TIMESTAMP(3),
  "excludeFromLeaderboards" BOOLEAN      NOT NULL DEFAULT false,
  "profilePictureId"        INTEGER,
  "settings"                JSONB        DEFAULT '{}',
  "publicSettings"          JSONB        DEFAULT '{}'
);

CREATE TABLE "hot_reads_2_parity"."UserRank" (
  "userId"              INTEGER NOT NULL PRIMARY KEY,
  "leaderboardRank"     INTEGER,
  "leaderboardId"       TEXT,
  "leaderboardTitle"    TEXT,
  "leaderboardCosmetic" TEXT
);

CREATE TABLE "hot_reads_2_parity"."UserStat" (
  "userId"                 INTEGER NOT NULL PRIMARY KEY,
  "uploadCountAllTime"     INTEGER NOT NULL,
  "downloadCountAllTime"   INTEGER NOT NULL,
  "generationCountAllTime" INTEGER NOT NULL,
  "followerCountAllTime"   INTEGER NOT NULL,
  "thumbsUpCountAllTime"   INTEGER NOT NULL,
  "reactionCountAllTime"   INTEGER NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."UserLink" (
  "id"     INTEGER                          NOT NULL PRIMARY KEY,
  "userId" INTEGER                          NOT NULL,
  "url"    TEXT                             NOT NULL,
  "type"   "hot_reads_2_parity"."LinkType"  NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."Cosmetic" (
  "id"          INTEGER                               NOT NULL PRIMARY KEY,
  "name"        TEXT                                  NOT NULL,
  "description" TEXT,
  "type"        "hot_reads_2_parity"."CosmeticType"   NOT NULL,
  "source"      "hot_reads_2_parity"."CosmeticSource" NOT NULL,
  "data"        JSONB                                 NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."UserCosmetic" (
  "userId"       INTEGER      NOT NULL,
  "cosmeticId"   INTEGER      NOT NULL,
  "claimKey"     TEXT         NOT NULL DEFAULT 'claimed',
  "equippedAt"   TIMESTAMP(3),
  "equippedToId" INTEGER,
  "data"         JSONB,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_2_parity"."Image" (
  "id"        INTEGER                                     NOT NULL PRIMARY KEY,
  "name"      TEXT,
  "url"       TEXT                                        NOT NULL,
  "userId"    INTEGER                                     NOT NULL,
  "hash"      TEXT,
  "height"    INTEGER,
  "width"     INTEGER,
  "type"      "hot_reads_2_parity"."MediaType"            NOT NULL DEFAULT 'image',
  "metadata"  JSONB                                       NOT NULL DEFAULT '{}',
  "nsfwLevel" INTEGER                                     NOT NULL DEFAULT 0,
  "ingestion" "hot_reads_2_parity"."ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
);

CREATE TABLE "hot_reads_2_parity"."Model" (
  "id"                    INTEGER                                 NOT NULL PRIMARY KEY,
  "name"                  TEXT                                    NOT NULL,
  "description"           TEXT,
  "type"                  "hot_reads_2_parity"."ModelType"        NOT NULL,
  "updatedAt"             TIMESTAMP(3)                            NOT NULL,
  "nsfw"                  BOOLEAN                                 NOT NULL DEFAULT false,
  "poi"                   BOOLEAN                                 NOT NULL DEFAULT false,
  "minor"                 BOOLEAN                                 NOT NULL DEFAULT false,
  "userId"                INTEGER                                 NOT NULL,
  "status"                "hot_reads_2_parity"."ModelStatus"      NOT NULL DEFAULT 'Draft',
  "publishedAt"           TIMESTAMP(3),
  "meta"                  JSONB                                   NOT NULL DEFAULT '{}',
  "deletedAt"             TIMESTAMP(3),
  "deletedBy"             INTEGER,
  "checkpointType"        "hot_reads_2_parity"."CheckpointType",
  "uploadType"            "hot_reads_2_parity"."ModelUploadType"  NOT NULL DEFAULT 'Created',
  "locked"                BOOLEAN                                 NOT NULL DEFAULT false,
  "mode"                  "hot_reads_2_parity"."ModelModifier",
  "availability"          "hot_reads_2_parity"."Availability"     NOT NULL DEFAULT 'Public',
  "nsfwLevel"             INTEGER                                 NOT NULL DEFAULT 0,
  "lockedProperties"      TEXT[]                                  NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sfwOnly"               BOOLEAN                                 NOT NULL DEFAULT false,
  "isOfficial"            BOOLEAN                                 NOT NULL DEFAULT false,
  "sfwName"               TEXT,
  "sfwDescription"        TEXT,
  "coverImageId"          INTEGER,
  "sfwCoverImageId"       INTEGER,
  "allowNoCredit"         BOOLEAN                                 NOT NULL DEFAULT true,
  "allowCommercialUse"    "hot_reads_2_parity"."CommercialUse"[]  NOT NULL DEFAULT ARRAY['Image']::"hot_reads_2_parity"."CommercialUse"[],
  "allowDerivatives"      BOOLEAN                                 NOT NULL DEFAULT true,
  "allowDifferentLicense" BOOLEAN                                 NOT NULL DEFAULT true
);

CREATE TABLE "hot_reads_2_parity"."ModelReportStat" (
  "modelId"             INTEGER NOT NULL PRIMARY KEY,
  "ownershipProcessing" INTEGER NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."ModelMetric" (
  "modelId"           INTEGER NOT NULL PRIMARY KEY,
  "downloadCount"     INTEGER NOT NULL DEFAULT 0,
  "commentCount"      INTEGER NOT NULL DEFAULT 0,
  "collectedCount"    INTEGER NOT NULL DEFAULT 0,
  "imageCount"        INTEGER NOT NULL DEFAULT 0,
  "tippedAmountCount" INTEGER NOT NULL DEFAULT 0,
  "generationCount"   INTEGER NOT NULL DEFAULT 0,
  "thumbsUpCount"     INTEGER NOT NULL DEFAULT 0,
  "thumbsDownCount"   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "hot_reads_2_parity"."License" (
  "id"   INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT    NOT NULL,
  "url"  TEXT    NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."_LicenseToModel" (
  "A" INTEGER NOT NULL,
  "B" INTEGER NOT NULL,
  PRIMARY KEY ("A", "B")
);

CREATE TABLE "hot_reads_2_parity"."ModelVersion" (
  "id"              INTEGER                                   NOT NULL PRIMARY KEY,
  "index"           INTEGER,
  "name"            TEXT                                      NOT NULL,
  "description"     TEXT,
  "modelId"         INTEGER                                   NOT NULL,
  "trainedWords"    TEXT[],
  "steps"           INTEGER,
  "epochs"          INTEGER,
  "clipSkip"        INTEGER,
  "createdAt"       TIMESTAMP(3)                              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)                              NOT NULL,
  "publishedAt"     TIMESTAMP(3),
  "status"          "hot_reads_2_parity"."ModelStatus"        NOT NULL DEFAULT 'Draft',
  "trainingStatus"  "hot_reads_2_parity"."TrainingStatus",
  "trainingDetails" JSONB,
  "inaccurate"      BOOLEAN                                   NOT NULL DEFAULT false,
  "baseModel"       TEXT                                      NOT NULL,
  "baseModelType"   TEXT                                      NOT NULL DEFAULT 'Standard',
  "meta"            JSONB                                     NOT NULL DEFAULT '{}',
  "requireAuth"     BOOLEAN                                   NOT NULL DEFAULT false,
  "settings"        JSONB,
  "availability"    "hot_reads_2_parity"."Availability"       NOT NULL DEFAULT 'Public',
  "nsfwLevel"       INTEGER                                   NOT NULL DEFAULT 0,
  "uploadType"      "hot_reads_2_parity"."ModelUploadType"    NOT NULL DEFAULT 'Created',
  "usageControl"    "hot_reads_2_parity"."ModelUsageControl"  NOT NULL DEFAULT 'Download',
  "flags"           INTEGER                                   NOT NULL DEFAULT 0,
  "generatorLoaded" BOOLEAN                                   NOT NULL DEFAULT false,
  "licensingFee"    DECIMAL(10, 2)
);

CREATE TABLE "hot_reads_2_parity"."ModelVersionMetric" (
  "modelVersionId"  INTEGER NOT NULL PRIMARY KEY,
  "downloadCount"   INTEGER NOT NULL DEFAULT 0,
  "generationCount" INTEGER NOT NULL DEFAULT 0,
  "thumbsUpCount"   INTEGER NOT NULL DEFAULT 0,
  "thumbsDownCount" INTEGER NOT NULL DEFAULT 0,
  "earnedAmount"    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "hot_reads_2_parity"."ModelFile" (
  "id"                INTEGER                                     NOT NULL PRIMARY KEY,
  "name"              TEXT                                        NOT NULL,
  "overrideName"      TEXT,
  "url"               TEXT                                        NOT NULL,
  "sizeKB"            DOUBLE PRECISION                            NOT NULL,
  "type"              TEXT                                        NOT NULL DEFAULT 'Model',
  "modelVersionId"    INTEGER                                     NOT NULL,
  "pickleScanResult"  "hot_reads_2_parity"."ScanResultCode"       NOT NULL DEFAULT 'Pending',
  "pickleScanMessage" TEXT,
  "virusScanResult"   "hot_reads_2_parity"."ScanResultCode"       NOT NULL DEFAULT 'Pending',
  "virusScanMessage"  TEXT,
  "scannedAt"         TIMESTAMP(3),
  "metadata"          JSONB,
  "visibility"        "hot_reads_2_parity"."ModelFileVisibility"  NOT NULL DEFAULT 'Public',
  "dataPurged"        BOOLEAN                                     NOT NULL DEFAULT false,
  "replacedAt"        TIMESTAMP(3)
);

CREATE TABLE "hot_reads_2_parity"."ModelFileHash" (
  "fileId" INTEGER                               NOT NULL,
  "type"   "hot_reads_2_parity"."ModelHashType"  NOT NULL,
  "hash"   TEXT                                  NOT NULL,
  PRIMARY KEY ("fileId", "type")
);

CREATE TABLE "hot_reads_2_parity"."GenerationCoverage" (
  "modelId"        INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL UNIQUE,
  "covered"        BOOLEAN NOT NULL,
  "coveredNext"    BOOLEAN NOT NULL,
  PRIMARY KEY ("modelId", "modelVersionId")
);

CREATE TABLE "hot_reads_2_parity"."RecommendedResource" (
  "id"         INTEGER NOT NULL PRIMARY KEY,
  "resourceId" INTEGER NOT NULL,
  "sourceId"   INTEGER,
  "settings"   JSONB
);
