-- Minimal schema for hot-reads-2.kysely-parity.test.ts. The four VIEWS at the end are built from
-- their production definitions over the base tables they read.
--
-- Only the tables the model-page, creator-card, image-tag and image-thread reads touch, and only
-- the columns those reads select or filter on. Types, nullability and primary keys follow
-- schema.full.prisma. Everything lives in its own schema, hot_reads_2_parity, because other parity
-- suites share the throwaway database. CITEXT columns ("User"."username", "Model"."name", "ModelFileHash"."hash") are TEXT
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
CREATE TYPE "hot_reads_2_parity"."MetricTimeframe" AS ENUM ('Day', 'Week', 'Month', 'Year', 'AllTime');
CREATE TYPE "hot_reads_2_parity"."ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Ownership', 'AdminAttention', 'Claim', 'CSAM', 'Automated', 'Spam', 'StickerPlacement');
CREATE TYPE "hot_reads_2_parity"."ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');

-- The app's iif(), from programmability/IIF.sql, which the views below call.
CREATE FUNCTION "hot_reads_2_parity".iif(condition boolean, true_result anyelement, false_result anyelement)
  RETURNS anyelement IMMUTABLE LANGUAGE sql AS
$$ SELECT CASE WHEN condition THEN true_result ELSE false_result END $$
CREATE TYPE "hot_reads_2_parity"."TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation', 'System');
CREATE TYPE "hot_reads_2_parity"."TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive', 'MinorDetection', 'HiveDemographics', 'Clavata', 'SpineRating', 'AiRecognition', 'AnimeRecognition');

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

CREATE TABLE "hot_reads_2_parity"."ModelMetric" (
  "modelId"           INTEGER NOT NULL PRIMARY KEY,
  "userId"            INTEGER NOT NULL DEFAULT 0,
  "status"            "hot_reads_2_parity"."ModelStatus"  NOT NULL DEFAULT 'Draft',
  "availability"      "hot_reads_2_parity"."Availability" NOT NULL DEFAULT 'Public',
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

CREATE TABLE "hot_reads_2_parity"."RecommendedResource" (
  "id"         INTEGER NOT NULL PRIMARY KEY,
  "resourceId" INTEGER NOT NULL,
  "sourceId"   INTEGER,
  "settings"   JSONB
);

CREATE TABLE "hot_reads_2_parity"."Thread" (
  "id"      INTEGER NOT NULL PRIMARY KEY,
  "locked"  BOOLEAN NOT NULL DEFAULT false,
  "imageId" INTEGER UNIQUE,
  "modelId" INTEGER UNIQUE
);

-- Base tables of the views below. Only the columns the view definitions read.

CREATE TABLE "hot_reads_2_parity"."UserMetric" (
  "userId"            INTEGER                                 NOT NULL,
  "timeframe"         "hot_reads_2_parity"."MetricTimeframe"  NOT NULL,
  "followingCount"    INTEGER                                 NOT NULL DEFAULT 0,
  "followerCount"     INTEGER                                 NOT NULL DEFAULT 0,
  "reactionCount"     INTEGER                                 NOT NULL DEFAULT 0,
  "hiddenCount"       INTEGER                                 NOT NULL DEFAULT 0,
  "uploadCount"       INTEGER                                 NOT NULL DEFAULT 0,
  "reviewCount"       INTEGER                                 NOT NULL DEFAULT 0,
  "answerCount"       INTEGER                                 NOT NULL DEFAULT 0,
  "answerAcceptCount" INTEGER                                 NOT NULL DEFAULT 0,
  PRIMARY KEY ("userId", "timeframe")
);

CREATE TABLE "hot_reads_2_parity"."Report" (
  "id"     INTEGER                              NOT NULL PRIMARY KEY,
  "reason" "hot_reads_2_parity"."ReportReason"  NOT NULL,
  "status" "hot_reads_2_parity"."ReportStatus"  NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."ModelReport" (
  "modelId"  INTEGER NOT NULL,
  "reportId" INTEGER NOT NULL UNIQUE,
  PRIMARY KEY ("reportId", "modelId")
);

CREATE TABLE "hot_reads_2_parity"."EcosystemCheckpoints" (
  "id"   INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT    NOT NULL
);

CREATE TABLE "hot_reads_2_parity"."GenerationBaseModel" (
  "baseModel" TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE "hot_reads_2_parity"."CoveredCheckpoint" (
  "model_id"   INTEGER NOT NULL,
  "version_id" INTEGER NOT NULL,
  PRIMARY KEY ("model_id", "version_id")
);

CREATE TABLE "hot_reads_2_parity"."Tag" (
  "id"         INTEGER                          NOT NULL PRIMARY KEY,
  "name"       TEXT                             NOT NULL,
  "color"      TEXT,
  "createdAt"  TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "target"     TEXT[]                           NOT NULL DEFAULT ARRAY[]::TEXT[],
  "unlisted"   BOOLEAN                          NOT NULL DEFAULT false,
  "isCategory" BOOLEAN                          NOT NULL DEFAULT false,
  "unfeatured" BOOLEAN                          NOT NULL DEFAULT false,
  "type"       "hot_reads_2_parity"."TagType"   NOT NULL DEFAULT 'UserGenerated',
  "adminOnly"  BOOLEAN                          NOT NULL DEFAULT false,
  "nsfwLevel"  INTEGER                          NOT NULL DEFAULT 1
);

CREATE TABLE "hot_reads_2_parity"."TagsOnImageDetails" (
  "imageId"     INTEGER                            NOT NULL,
  "tagId"       INTEGER                            NOT NULL,
  "source"      "hot_reads_2_parity"."TagSource"   NOT NULL,
  "automated"   BOOLEAN                            NOT NULL,
  "disabled"    BOOLEAN                            NOT NULL,
  "needsReview" BOOLEAN                            NOT NULL,
  "confidence"  INTEGER                            NOT NULL,
  PRIMARY KEY ("imageId", "tagId")
);

CREATE TABLE "hot_reads_2_parity"."TagsOnImageVote" (
  "imageId"   INTEGER      NOT NULL,
  "tagId"     INTEGER      NOT NULL,
  "userId"    INTEGER      NOT NULL,
  "vote"      INTEGER      NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tagId", "imageId", "userId")
);

-- The four VIEWS the reads touch, copied from their latest migration with every relation, enum and
-- function qualified to this schema and nothing else changed, so their column types (sums are
-- BIGINT or NUMERIC, not INTEGER) and their plans are the production ones:
--   "UserStat"           migrations/20251123233705_userstats_shrink
--   "ModelReportStat"    migrations/20230209225221_rename_inaction_unaction
--   "GenerationCoverage" migrations/20260923140000_generation_coverage_two_rules_one_view
--   "ImageTag"           migrations/20260921130000_tag_drop_nsfw_enum

CREATE VIEW "hot_reads_2_parity"."UserStat"
            ("userId", "uploadCountAllTime", "reviewCountAllTime", "downloadCountAllTime",
             "generationCountAllTime", "followingCountAllTime", "followerCountAllTime",
             "hiddenCountAllTime", "answerCountAllTime", "answerAcceptCountAllTime",
             "thumbsUpCountAllTime", "thumbsDownCountAllTime", "reactionCountAllTime")
AS
WITH user_model_metrics AS (
    SELECT mm."userId",
      sum(mm."downloadCount") AS "downloadCountAllTime",
      sum(mm."generationCount") AS "generationCountAllTime",
      sum(mm."thumbsUpCount") AS "thumbsUpCountAllTime"
    FROM "hot_reads_2_parity"."ModelMetric" mm
    WHERE mm.status = 'Published'
    AND mm.availability != 'Private'
    GROUP BY mm."userId"
), user_counts AS (
    SELECT um."userId",
      COALESCE(sum(um."followingCount"), 0::bigint) AS "followingCountAllTime",
      COALESCE(sum(um."followerCount"), 0::bigint) AS "followerCountAllTime",
      COALESCE(sum(um."hiddenCount"), 0::bigint) AS "hiddenCountAllTime",
      COALESCE(sum(um."uploadCount"), 0::bigint) AS "uploadCountAllTime",
      COALESCE(sum(um."reviewCount"), 0::bigint) AS "reviewCountAllTime",
      COALESCE(sum(um."answerCount"), 0::bigint) AS "answerCountAllTime",
      COALESCE(sum(um."answerAcceptCount"), 0::bigint) AS "answerAcceptCountAllTime",
      COALESCE(sum(um."reactionCount"), 0::bigint) AS "reactionCountAllTime"
    FROM "hot_reads_2_parity"."UserMetric" um
    WHERE um.timeframe = 'AllTime'::"hot_reads_2_parity"."MetricTimeframe"
    GROUP BY um."userId"
)
SELECT u."userId",
  u."uploadCountAllTime",
  u."reviewCountAllTime",
  COALESCE(m."downloadCountAllTime", 0::bigint) AS "downloadCountAllTime",
  COALESCE(m."generationCountAllTime", 0::bigint) AS "generationCountAllTime",
  u."followingCountAllTime",
  u."followerCountAllTime",
  u."hiddenCountAllTime",
  u."answerCountAllTime",
  u."answerAcceptCountAllTime",
  COALESCE(m."thumbsUpCountAllTime", 0::bigint) AS "thumbsUpCountAllTime",
  0::bigint AS "thumbsDownCountAllTime",
  u."reactionCountAllTime",
  0 as "ratingAllTime",
  0 as "ratingCountAllTime",
  0 as "favoriteCountAllTime",
  0 as "ratingMonth",
  0 as "ratingCountMonth",
  0 as "downloadCountMonth",
  0 as "favoriteCountMonth",
  0 as "thumbsUpCountMonth",
  0 as "uploadCountMonth",
  0 as "answerCountMonth"
FROM user_counts u
LEFT JOIN user_model_metrics m ON m."userId" = u."userId";

CREATE VIEW "hot_reads_2_parity"."ModelReportStat" AS
SELECT m.id "modelId",
       SUM("hot_reads_2_parity".IIF("reason" = 'TOSViolation' AND r.status = 'Pending', 1, 0)) "tosViolationPending",
       SUM("hot_reads_2_parity".IIF("reason" = 'TOSViolation' AND r.status = 'Actioned', 1, 0)) "tosViolationActioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'TOSViolation' AND r.status = 'Unactioned', 1, 0)) "tosViolationUnactioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'NSFW' AND r.status = 'Pending', 1, 0)) "nsfwPending",
       SUM("hot_reads_2_parity".IIF("reason" = 'NSFW' AND r.status = 'Actioned', 1, 0)) "nsfwActioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'NSFW' AND r.status = 'Unactioned', 1, 0)) "nsfwUnactioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'Ownership' AND r.status = 'Pending', 1, 0)) "ownershipPending",
       SUM("hot_reads_2_parity".IIF("reason" = 'Ownership' AND r.status = 'Processing', 1, 0)) "ownershipProcessing",
       SUM("hot_reads_2_parity".IIF("reason" = 'Ownership' AND r.status = 'Actioned', 1, 0)) "ownershipActioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'Ownership' AND r.status = 'Unactioned', 1, 0)) "ownershipUnactioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'AdminAttention' AND r.status = 'Pending', 1, 0)) "adminAttentionPending",
       SUM("hot_reads_2_parity".IIF("reason" = 'AdminAttention' AND r.status = 'Actioned', 1, 0)) "adminAttentionActioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'AdminAttention' AND r.status = 'Unactioned', 1, 0)) "adminAttentionUnactioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'Claim' AND r.status = 'Pending', 1, 0)) "claimPending",
       SUM("hot_reads_2_parity".IIF("reason" = 'Claim' AND r.status = 'Actioned', 1, 0)) "claimActioned",
       SUM("hot_reads_2_parity".IIF("reason" = 'Claim' AND r.status = 'Unactioned', 1, 0)) "claimUnactioned"
FROM "hot_reads_2_parity"."Model" m
LEFT JOIN "hot_reads_2_parity"."ModelReport" mr ON mr."modelId" = m.id
JOIN "hot_reads_2_parity"."Report" r ON r."id" = mr."reportId"
GROUP BY m.id;

CREATE VIEW "hot_reads_2_parity"."GenerationCoverage" AS
SELECT "modelId", "modelVersionId", covered, "coveredNext"
FROM (
  SELECT
    m.id AS "modelId",
    mv.id AS "modelVersionId",
    (b.eco OR b.ext OR (b.common AND f.live_file AND (b.other_type OR (b.ckpt AND b.auction)))) AS covered,
    (b.eco OR b.ext OR (b.common AND f.next_file AND (b.other_type OR (b.ckpt AND f.safetensor)))) AS "coveredNext"
  FROM "hot_reads_2_parity"."ModelVersion" mv
  JOIN "hot_reads_2_parity"."Model" m ON m.id = mv."modelId"
  LEFT JOIN LATERAL (
    SELECT
      (mv.id IN (SELECT "EcosystemCheckpoints".id FROM "hot_reads_2_parity"."EcosystemCheckpoints")) AS eco,
      (
        mv."usageControl" = 'ExternalGeneration'::"hot_reads_2_parity"."ModelUsageControl"
        AND mv.status = 'Published'::"hot_reads_2_parity"."ModelStatus"
        AND NOT m.poi
      ) AS ext,
      (
        NOT m.poi
        AND (
          mv.status = 'Published'::"hot_reads_2_parity"."ModelStatus"
          OR m.availability = 'Private'::"hot_reads_2_parity"."Availability"
          OR m."uploadType" = 'Trained'::"hot_reads_2_parity"."ModelUploadType"
        )
        AND m."allowCommercialUse" && ARRAY['RentCivit'::"hot_reads_2_parity"."CommercialUse"]
        AND (
          mv."baseModel" IN (SELECT "GenerationBaseModel"."baseModel" FROM "hot_reads_2_parity"."GenerationBaseModel")
          OR m.type = 'Upscaler'::"hot_reads_2_parity"."ModelType"
        )
      ) AS common,
      (m.type = 'Checkpoint'::"hot_reads_2_parity"."ModelType" AND mv."baseModelType" = 'Standard') AS ckpt,
      (
        m.type = ANY (ARRAY['LORA'::"hot_reads_2_parity"."ModelType", 'TextualInversion'::"hot_reads_2_parity"."ModelType", 'VAE'::"hot_reads_2_parity"."ModelType", 'LoCon'::"hot_reads_2_parity"."ModelType", 'DoRA'::"hot_reads_2_parity"."ModelType"])
        OR m.type = 'Upscaler'::"hot_reads_2_parity"."ModelType"
      ) AS other_type,
      (mv.id IN (SELECT "CoveredCheckpoint".version_id FROM "hot_reads_2_parity"."CoveredCheckpoint")) AS auction
  ) b ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(bool_or(ok_live), false) AS live_file,
      COALESCE(bool_or(ok_next), false) AS next_file,
      COALESCE(bool_or(is_safetensor), false) AS safetensor
    FROM (
      SELECT
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Diffusers'::text, 'Core ML'::text, 'ONNX'::text])
          )
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
        ) AS ok_live,
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Core ML'::text, 'ONNX'::text])
          )
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
        ) AS ok_next,
        (
          mf."scannedAt" IS NOT NULL
          AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
          AND mf.metadata ->> 'format'::text = 'SafeTensor'
        ) AS is_safetensor
      FROM "hot_reads_2_parity"."ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
    ) files
  ) f ON TRUE
  WHERE m.mode IS NULL
) rules
WHERE covered OR "coveredNext";

CREATE VIEW "hot_reads_2_parity"."ImageTag" AS
SELECT it."imageId",
    it."tagId",
    toi.automated,
    toi.confidence,
    COALESCE((10 * toi.confidence / 100)::numeric, 0::numeric) + COALESCE(v.score::numeric, 0::numeric) AS score,
    COALESCE(v."upVotes", 0::bigint) AS "upVotes",
    COALESCE(v."downVotes", 0::bigint) AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType",
    t."nsfwLevel" AS "tagNsfwLevel",
    toi."needsReview",
    true AS concrete,
    v."lastUpvote",
    toi.source
   FROM ( SELECT toi_1."imageId",
            toi_1."tagId"
           FROM "hot_reads_2_parity"."TagsOnImageDetails" toi_1
        UNION
         SELECT toiv."imageId",
            toiv."tagId"
           FROM "hot_reads_2_parity"."TagsOnImageVote" toiv) it
     LEFT JOIN "hot_reads_2_parity"."TagsOnImageDetails" toi ON it."imageId" = toi."imageId" AND it."tagId" = toi."tagId"
     CROSS JOIN LATERAL ( SELECT sum(v_1.vote) AS score,
            sum("hot_reads_2_parity".iif(v_1.vote > 0, 1, 0)) AS "upVotes",
            sum("hot_reads_2_parity".iif(v_1.vote < 0, 1, 0)) AS "downVotes",
            max("hot_reads_2_parity".iif(v_1.vote > 0, v_1."createdAt", NULL::timestamp without time zone)) AS "lastUpvote"
           FROM "hot_reads_2_parity"."TagsOnImageVote" v_1
          WHERE v_1."imageId" = it."imageId" AND v_1."tagId" = it."tagId") v
     CROSS JOIN LATERAL ( SELECT t_1.name,
            t_1.color,
            t_1."createdAt",
            t_1."updatedAt",
            t_1.id,
            t_1.target,
            t_1.unlisted,
            t_1."isCategory",
            t_1.unfeatured,
            t_1.type,
            t_1."adminOnly",
            t_1."nsfwLevel"
           FROM "hot_reads_2_parity"."Tag" t_1
          WHERE t_1.id = it."tagId" AND NOT t_1.unlisted
         LIMIT 1) t
  WHERE NOT toi.disabled;
