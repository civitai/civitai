-- Minimal schema for image-generation-data.kysely-parity.test.ts.
--
-- Only the tables getImageGenerationData reads: the image row with its tool/technique links (the
-- ported read), and the tables its visibility checks join. Column types, primary keys and the
-- link-table foreign keys are copied from the DDL Prisma generates for schema.full.prisma, and columns
-- nothing here reads are left out. The link-table foreign keys are kept on purpose: they are what
-- makes an inner join to Tool/Technique equivalent to Prisma's required relation.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against KYSELY_PARITY_DATABASE_URL, which must be a THROWAWAY database: this drops and
-- recreates everything below on every run.

DROP TABLE IF EXISTS "ImageTool" CASCADE;
DROP TABLE IF EXISTS "ImageTechnique" CASCADE;
DROP TABLE IF EXISTS "Tool" CASCADE;
DROP TABLE IF EXISTS "Technique" CASCADE;
DROP TABLE IF EXISTS "ImageConnection" CASCADE;
DROP TABLE IF EXISTS "BountyEntry" CASCADE;
DROP TABLE IF EXISTS "Bounty" CASCADE;
DROP TABLE IF EXISTS "CollectionContributor" CASCADE;
DROP TABLE IF EXISTS "Article" CASCADE;
DROP TABLE IF EXISTS "Image" CASCADE;
DROP TABLE IF EXISTS "Post" CASCADE;
DROP TYPE IF EXISTS "MediaType";
DROP TYPE IF EXISTS "ImageGenerationProcess";
DROP TYPE IF EXISTS "ImageIngestionStatus";
DROP TYPE IF EXISTS "Availability";
DROP TYPE IF EXISTS "CollectionContributorPermission";
DROP TYPE IF EXISTS "ToolType";
DROP TYPE IF EXISTS "TechniqueType";
DROP TYPE IF EXISTS "ArticleStatus";
DROP TYPE IF EXISTS "ArticleIngestionStatus";

CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "ImageGenerationProcess" AS ENUM ('txt2img', 'txt2imgHiRes', 'img2img', 'inpainting');
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
CREATE TYPE "ToolType" AS ENUM ('Image', 'Video', 'MotionCapture', 'Upscalers', 'Audio', 'Compute', 'GameEngines', 'Editor', 'LLM');
CREATE TYPE "TechniqueType" AS ENUM ('Image', 'Video');
CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');

CREATE TABLE "Post" (
  "id"           INTEGER        NOT NULL PRIMARY KEY,
  "userId"       INTEGER        NOT NULL,
  "publishedAt"  TIMESTAMP(3),
  "collectionId" INTEGER,
  "availability" "Availability" NOT NULL DEFAULT 'Public'
);

CREATE TABLE "Image" (
  "id"                INTEGER                  NOT NULL PRIMARY KEY,
  "userId"            INTEGER                  NOT NULL,
  "postId"            INTEGER,
  "meta"              JSONB,
  "type"              "MediaType"              NOT NULL DEFAULT 'image',
  "metadata"          JSONB                    NOT NULL DEFAULT '{}',
  "nsfwLevel"         INTEGER                  NOT NULL DEFAULT 0,
  "nsfwLevelLocked"   BOOLEAN                  NOT NULL DEFAULT false,
  "generationProcess" "ImageGenerationProcess",
  "needsReview"       TEXT,
  "hideMeta"          BOOLEAN                  NOT NULL DEFAULT false,
  "ingestion"         "ImageIngestionStatus"   NOT NULL DEFAULT 'Pending',
  "scanJobs"          JSONB
);

CREATE TABLE "Article" (
  "id"          INTEGER                  NOT NULL PRIMARY KEY,
  "coverId"     INTEGER,
  "publishedAt" TIMESTAMP(3),
  "ingestion"   "ArticleIngestionStatus" NOT NULL DEFAULT 'Pending',
  "status"      "ArticleStatus"          NOT NULL DEFAULT 'Draft'
);

CREATE TABLE "CollectionContributor" (
  "userId"       INTEGER NOT NULL,
  "collectionId" INTEGER NOT NULL,
  "permissions"  "CollectionContributorPermission"[]
);

CREATE TABLE "Bounty" (
  "id"           INTEGER        NOT NULL PRIMARY KEY,
  "userId"       INTEGER,
  "availability" "Availability" NOT NULL DEFAULT 'Public'
);

CREATE TABLE "BountyEntry" (
  "id"       INTEGER NOT NULL PRIMARY KEY,
  "userId"   INTEGER,
  "bountyId" INTEGER NOT NULL
);

CREATE TABLE "ImageConnection" (
  "imageId"    INTEGER NOT NULL,
  "entityId"   INTEGER NOT NULL,
  "entityType" TEXT    NOT NULL
);

CREATE TABLE "Tool" (
  "id"        INTEGER      NOT NULL PRIMARY KEY,
  "name"      TEXT         NOT NULL,
  "icon"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enabled"   BOOLEAN      NOT NULL DEFAULT true,
  "unlisted"  BOOLEAN      NOT NULL DEFAULT false,
  "type"      "ToolType"   NOT NULL,
  "domain"    TEXT,
  "priority"  INTEGER,
  "metadata"  JSONB        NOT NULL DEFAULT '{}'
);

CREATE TABLE "Technique" (
  "id"        INTEGER         NOT NULL PRIMARY KEY,
  "name"      TEXT            NOT NULL,
  "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enabled"   BOOLEAN         NOT NULL DEFAULT true,
  "type"      "TechniqueType" NOT NULL
);

CREATE TABLE "ImageTool" (
  "imageId"   INTEGER      NOT NULL REFERENCES "Image"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "toolId"    INTEGER      NOT NULL REFERENCES "Tool"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "notes"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageTool_pkey" PRIMARY KEY ("imageId", "toolId")
);
CREATE INDEX "ImageTool_toolId_idx" ON "ImageTool"("toolId");

CREATE TABLE "ImageTechnique" (
  "imageId"     INTEGER      NOT NULL REFERENCES "Image"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "techniqueId" INTEGER      NOT NULL REFERENCES "Technique"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageTechnique_pkey" PRIMARY KEY ("imageId", "techniqueId")
);
CREATE INDEX "ImageTechnique_techniqueId_idx" ON "ImageTechnique"("techniqueId");
