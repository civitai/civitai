-- ============================================================
-- 3D Models (PolyGen / generated content) support — Phase 1 schema
-- Apply manually per project convention (no `prisma migrate deploy`).
-- See docs/3d-models-plan.md for the design.
--
-- Scope: generated 3D models (Meshy via orchestrator PolyGen). Data
-- structure is also upload-ready (nullable workflowId/sourceImageId,
-- multi-format file list) so user uploads can be enabled later
-- without a schema migration.
--
-- ★ IMPORTANT — TWO-TRANSACTION STRUCTURE ★
-- Postgres requires `ALTER TYPE ... ADD VALUE` to be COMMITTED before
-- the new value can be USED. The Tag seed (section 18) inserts rows
-- using `'Model3D'::"TagTarget"` — if it runs in the same transaction
-- as the ALTER TYPE in section 1, you get:
--   ERROR: unsafe use of new value "Model3D" of enum type "TagTarget"
--
-- This file is split into TWO transactions via the explicit
-- `COMMIT; BEGIN;` between sections 1 and 2. If your apply tool
-- (psql / Retool / etc.) wraps the whole file in BEGIN/COMMIT, that
-- still works: the inner COMMIT closes the wrapper, the inner BEGIN
-- starts a fresh transaction, and the outer COMMIT closes that one.
--
-- If your tool runs each statement in autocommit mode, the COMMIT
-- and BEGIN below are effectively no-ops — still safe.
-- ============================================================

-- -----------------------------
-- 1. AlterEnum: existing enums (transaction 1)
-- -----------------------------
BEGIN;
ALTER TYPE "TagTarget"      ADD VALUE IF NOT EXISTS 'Model3D';
ALTER TYPE "CosmeticEntity" ADD VALUE IF NOT EXISTS 'Model3D';
ALTER TYPE "CollectionType" ADD VALUE IF NOT EXISTS 'Model3D';
ALTER TYPE "EntityType"     ADD VALUE IF NOT EXISTS 'Model3D';
COMMIT;

-- ★ Transaction 1 committed. New enum values are now usable below. ★
BEGIN;

-- -----------------------------
-- 2. CreateEnum
-- -----------------------------
CREATE TYPE "Model3DStatus"         AS ENUM ('Draft', 'Published', 'Unpublished', 'Deleted');
CREATE TYPE "Model3DEngagementType" AS ENUM ('Favorite', 'Hide', 'Notify');
-- Model3DFile.format is a free-text String (e.g. 'glb', 'fbx', 'obj',
-- 'usdz', 'stl') — matches civitai-client Model3dBlob.format.
-- Free-text instead of an enum so new formats from Meshy/orchestrator
-- can be ingested without a schema migration.

-- -----------------------------
-- 3. CreateTable: Model3DLicense
-- A separate table from `License` because physical-print / asset
-- licensing has dimensions (print-farm, redistribution) that the AI-
-- license shape doesn't cover. See plan §2.7.
-- -----------------------------
CREATE TABLE "Model3DLicense" (
    "id"                  SERIAL          NOT NULL,
    "name"                TEXT            NOT NULL,
    "description"         TEXT            NOT NULL,
    "allowCommercialUse"  BOOLEAN         NOT NULL DEFAULT false,
    "allowPrintFarm"      BOOLEAN         NOT NULL DEFAULT false,
    "allowDerivatives"    BOOLEAN         NOT NULL DEFAULT true,
    "allowRedistribution" BOOLEAN         NOT NULL DEFAULT false,
    "requireAttribution"  BOOLEAN         NOT NULL DEFAULT true,
    "isCustom"            BOOLEAN         NOT NULL DEFAULT false,
    "createdAt"           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Model3DLicense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Model3DLicense_printfarm_requires_commercial"
        CHECK (NOT "allowPrintFarm" OR "allowCommercialUse")
);

CREATE UNIQUE INDEX "Model3DLicense_name_key" ON "Model3DLicense"("name");

-- -----------------------------
-- 4. CreateTable: Model3D
-- v1 source = orchestrator generation (workflowId/sourceImageId set).
-- Schema is upload-ready: workflowId is nullable so a future "user
-- upload" flow can write rows with workflowId = NULL.
-- thumbnailImageId is nullable + SET NULL so existing image-deletion
-- paths don't throw on FK restriction. App layer enforces "thumbnail
-- required to publish".
-- -----------------------------
CREATE TABLE "Model3D" (
    "id"               SERIAL           NOT NULL,
    "name"             CITEXT           NOT NULL,
    "description"      TEXT,
    "userId"           INTEGER          NOT NULL,
    "thumbnailImageId" INTEGER,
    "licenseId"        INTEGER          NOT NULL,
    "licenseDetails"   TEXT,             -- free-text for custom licenses

    -- Generation provenance (NULL for future user-uploaded entries)
    "workflowId"       TEXT,             -- orchestrator workflow ID
    "sourceImageId"    INTEGER,          -- image-to-3D source
    "generationParams" JSONB,            -- PolyGen input snapshot (prompt, topology, polycount, seed, ...)

    "status"           "Model3DStatus"  NOT NULL DEFAULT 'Draft',
    "nsfw"             BOOLEAN          NOT NULL DEFAULT false,
    "tosViolation"     BOOLEAN          NOT NULL DEFAULT false,
    "poi"              BOOLEAN          NOT NULL DEFAULT false,
    "minor"            BOOLEAN          NOT NULL DEFAULT false,
    "unlisted"         BOOLEAN          NOT NULL DEFAULT false,
    "lockedProperties" TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
    "availability"     "Availability"   NOT NULL DEFAULT 'Public',
    "nsfwLevel"        INTEGER          NOT NULL DEFAULT 0,
    "meta"             JSONB            NOT NULL DEFAULT '{}',
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)     NOT NULL,
    "publishedAt"      TIMESTAMP(3),
    "deletedAt"        TIMESTAMP(3),
    "deletedBy"        INTEGER,

    CONSTRAINT "Model3D_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- 5. CreateTable: Model3DFile
-- A Model3D has 1..N files representing the SAME asset in different
-- formats (glb, fbx, obj, usdz, stl). The detail page presents these
-- as a "select format" dropdown, not as separate models.
-- No size cap in v1 (storage is not a constraint). Revisit if egress
-- costs spike post-launch.
-- -----------------------------
CREATE TABLE "Model3DFile" (
    "id"               SERIAL              NOT NULL,
    "model3dId"        INTEGER             NOT NULL,
    "name"             TEXT                NOT NULL,
    "url"              TEXT                NOT NULL,
    "sizeKB"           DOUBLE PRECISION    NOT NULL,
    "format"           TEXT                NOT NULL, -- 'glb', 'fbx', 'obj', 'usdz', 'stl', ...
    "isPrimary"        BOOLEAN             NOT NULL DEFAULT false, -- the default viewer/download format
    "metadata"         JSONB,
    "virusScanResult"  "ScanResultCode"    NOT NULL DEFAULT 'Success',  -- orchestrator-trusted in v1; switch to 'Pending' when user uploads land
    "virusScanMessage" TEXT,
    "rawScanResult"    JSONB,
    "scannedAt"        TIMESTAMP(3),
    "scanRequestedAt"  TIMESTAMP(3),
    "exists"           BOOLEAN,
    "createdAt"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Model3DFile_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- 6. CreateTable: TagsOnModel3D
-- -----------------------------
CREATE TABLE "TagsOnModel3D" (
    "model3dId" INTEGER       NOT NULL,
    "tagId"     INTEGER       NOT NULL,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnModel3D_pkey" PRIMARY KEY ("model3dId", "tagId")
);

-- -----------------------------
-- 7. CreateTable: Model3DEngagement
-- -----------------------------
CREATE TABLE "Model3DEngagement" (
    "userId"    INTEGER                   NOT NULL,
    "model3dId" INTEGER                   NOT NULL,
    "type"      "Model3DEngagementType"   NOT NULL,
    "createdAt" TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Model3DEngagement_pkey" PRIMARY KEY ("userId", "model3dId")
);

-- -----------------------------
-- 8. CreateTable: Model3DReport
-- -----------------------------
CREATE TABLE "Model3DReport" (
    "model3dId" INTEGER NOT NULL,
    "reportId"  INTEGER NOT NULL,

    CONSTRAINT "Model3DReport_pkey" PRIMARY KEY ("reportId", "model3dId")
);

-- -----------------------------
-- 9. CreateTable: Model3DReview
-- Parallel to ResourceReview. Star rating + recommend boolean + details.
-- One review per (model3dId, userId).
-- Review-on-review reactions are NOT included in v1.
-- -----------------------------
CREATE TABLE "Model3DReview" (
    "id"           SERIAL       NOT NULL,
    "model3dId"    INTEGER      NOT NULL,
    "userId"       INTEGER      NOT NULL,
    "rating"       INTEGER      NOT NULL,
    "recommended"  BOOLEAN      NOT NULL DEFAULT true,
    "details"      TEXT,
    "nsfw"         BOOLEAN      NOT NULL DEFAULT false,
    "tosViolation" BOOLEAN      NOT NULL DEFAULT false,
    "exclude"      BOOLEAN      NOT NULL DEFAULT false,
    "metadata"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Model3DReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Model3DReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

-- -----------------------------
-- 10. CreateTable: Model3DReviewReport
-- -----------------------------
CREATE TABLE "Model3DReviewReport" (
    "model3dReviewId" INTEGER NOT NULL,
    "reportId"        INTEGER NOT NULL,

    CONSTRAINT "Model3DReviewReport_pkey" PRIMARY KEY ("reportId", "model3dReviewId")
);

-- -----------------------------
-- 11. CreateTable: Model3DMetric
-- Denormalized columns at the bottom mirror ModelMetric so feed queries
-- can sort/filter without joining back to Model3D.
-- downloadCount is populated from ClickHouse events (not from a Postgres
-- DownloadHistory table — pilot intentionally avoids that table).
-- -----------------------------
CREATE TABLE "Model3DMetric" (
    "model3dId"         INTEGER         NOT NULL,
    "downloadCount"     INTEGER         NOT NULL DEFAULT 0,
    "commentCount"      INTEGER         NOT NULL DEFAULT 0,
    "collectedCount"    INTEGER         NOT NULL DEFAULT 0,
    "imageCount"        INTEGER         NOT NULL DEFAULT 0,
    "tippedCount"       INTEGER         NOT NULL DEFAULT 0,
    "tippedAmountCount" INTEGER         NOT NULL DEFAULT 0,
    "ratingCount"       INTEGER         NOT NULL DEFAULT 0,
    "ratingAvg"         DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recommendedCount"  INTEGER         NOT NULL DEFAULT 0,
    -- reactionCount denormalized from the thumbnail Image's ImageMetric;
    -- feed sort "by popular" reads this column directly to avoid joining.
    "reactionCount"     INTEGER         NOT NULL DEFAULT 0,
    "earnedAmount"      INTEGER         NOT NULL DEFAULT 0,
    "updatedAt"         TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Denormalized from Model3D for feed query perf
    "nsfwLevel"         INTEGER         NOT NULL DEFAULT 0,
    "userId"            INTEGER         NOT NULL DEFAULT 0,
    "status"            "Model3DStatus" NOT NULL DEFAULT 'Draft',
    "availability"      "Availability"  NOT NULL DEFAULT 'Public',
    "poi"               BOOLEAN         NOT NULL DEFAULT false,
    "minor"             BOOLEAN         NOT NULL DEFAULT false,

    CONSTRAINT "Model3DMetric_pkey" PRIMARY KEY ("model3dId")
);

-- -----------------------------
-- 12. AlterTable: Thread — add model3dId
-- -----------------------------
ALTER TABLE "Thread" ADD COLUMN "model3dId" INTEGER;
CREATE UNIQUE INDEX "Thread_model3dId_key" ON "Thread"("model3dId");

-- Reviews also get threads (for review comments later).
ALTER TABLE "Thread" ADD COLUMN "model3dReviewId" INTEGER;
CREATE UNIQUE INDEX "Thread_model3dReviewId_key" ON "Thread"("model3dReviewId");

-- -----------------------------
-- 13. AlterTable: Post — add model3dId + model3dReviewId
-- model3dId      = community "Makes/Uses" Posts + creator generation Post
-- model3dReviewId = Posts owned by a review (for review image attachments)
-- -----------------------------
ALTER TABLE "Post" ADD COLUMN "model3dId" INTEGER;
ALTER TABLE "Post" ADD COLUMN "model3dReviewId" INTEGER;
CREATE INDEX        "Post_model3dId_idx"       ON "Post"("model3dId");
CREATE UNIQUE INDEX "Post_model3dReviewId_key" ON "Post"("model3dReviewId");

-- -----------------------------
-- 14. AlterTable: CollectionItem — add model3dId + replace unique index
-- The original unique index was created with CREATE UNIQUE INDEX (not ADD
-- CONSTRAINT) and its name was truncated by Postgres to 63 chars, ending
-- "modelI_key" (not "modelId_key"). Drop BOTH names defensively, then
-- create a new shorter-named index that includes model3dId.
-- See prisma/migrations/20230719152210_setup_for_collection_review_items/migration.sql:31
-- -----------------------------
ALTER TABLE "CollectionItem" ADD COLUMN "model3dId" INTEGER;

DROP INDEX IF EXISTS "CollectionItem_collectionId_articleId_postId_imageId_modelI_key";
DROP INDEX IF EXISTS "CollectionItem_collectionId_articleId_postId_imageId_modelId_key";

CREATE UNIQUE INDEX "CollectionItem_unique_entity_with_model3d_key"
    ON "CollectionItem"("collectionId", "articleId", "postId", "imageId", "modelId", "model3dId");

CREATE INDEX "CollectionItem_model3dId_idx" ON "CollectionItem" USING HASH ("model3dId");

-- -----------------------------
-- 15. Indexes for new tables
-- -----------------------------
CREATE INDEX        "Model3D_userId_status_publishedAt_idx"     ON "Model3D"("userId", "status", "publishedAt" DESC);
CREATE INDEX        "Model3D_status_publishedAt_idx"            ON "Model3D"("status", "publishedAt" DESC);
CREATE INDEX        "Model3D_status_nsfwLevel_publishedAt_idx"  ON "Model3D"("status", "nsfwLevel", "publishedAt" DESC);
CREATE INDEX        "Model3D_name_idx"                          ON "Model3D"("name");
CREATE UNIQUE INDEX "Model3D_thumbnailImageId_key"              ON "Model3D"("thumbnailImageId");
CREATE INDEX        "Model3D_licenseId_idx"                     ON "Model3D" USING HASH ("licenseId");
CREATE UNIQUE INDEX "Model3D_workflowId_key"                    ON "Model3D"("workflowId");  -- prevents duplicate Post-from-Generation
CREATE INDEX        "Model3D_sourceImageId_idx"                 ON "Model3D" USING HASH ("sourceImageId");

CREATE INDEX        "Model3DFile_model3dId_idx"                 ON "Model3DFile" USING HASH ("model3dId");
CREATE UNIQUE INDEX "Model3DFile_model3dId_format_key"          ON "Model3DFile"("model3dId", "format");
-- At most one isPrimary=true file per Model3D
CREATE UNIQUE INDEX "Model3DFile_model3dId_isPrimary_key"       ON "Model3DFile"("model3dId") WHERE "isPrimary";

CREATE UNIQUE INDEX "Model3DReport_reportId_key"  ON "Model3DReport"("reportId");
CREATE INDEX        "Model3DReport_model3dId_idx" ON "Model3DReport" USING HASH ("model3dId");

CREATE UNIQUE INDEX "Model3DReview_model3dId_userId_key" ON "Model3DReview"("model3dId", "userId");
CREATE INDEX        "Model3DReview_model3dId_idx"        ON "Model3DReview" USING HASH ("model3dId");
CREATE INDEX        "Model3DReview_userId_idx"           ON "Model3DReview" USING HASH ("userId");

CREATE UNIQUE INDEX "Model3DReviewReport_reportId_key"        ON "Model3DReviewReport"("reportId");
CREATE INDEX        "Model3DReviewReport_model3dReviewId_idx" ON "Model3DReviewReport" USING HASH ("model3dReviewId");

CREATE INDEX "TagsOnModel3D_model3dId_idx" ON "TagsOnModel3D" USING HASH ("model3dId");
CREATE INDEX "TagsOnModel3D_tagId_idx"     ON "TagsOnModel3D" USING HASH ("tagId");

CREATE INDEX "Model3DEngagement_model3dId_idx" ON "Model3DEngagement" USING HASH ("model3dId");

-- -----------------------------
-- 16. AddForeignKey
-- -----------------------------
ALTER TABLE "Model3D"
    ADD CONSTRAINT "Model3D_userId_fkey"           FOREIGN KEY ("userId")           REFERENCES "User"("id")           ON DELETE RESTRICT  ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3D_deletedBy_fkey"        FOREIGN KEY ("deletedBy")        REFERENCES "User"("id")           ON DELETE SET NULL  ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3D_thumbnailImageId_fkey" FOREIGN KEY ("thumbnailImageId") REFERENCES "Image"("id")          ON DELETE SET NULL  ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3D_sourceImageId_fkey"    FOREIGN KEY ("sourceImageId")    REFERENCES "Image"("id")          ON DELETE SET NULL  ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3D_licenseId_fkey"        FOREIGN KEY ("licenseId")        REFERENCES "Model3DLicense"("id") ON DELETE RESTRICT  ON UPDATE CASCADE;

ALTER TABLE "Model3DFile"
    ADD CONSTRAINT "Model3DFile_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TagsOnModel3D"
    ADD CONSTRAINT "TagsOnModel3D_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TagsOnModel3D_tagId_fkey"     FOREIGN KEY ("tagId")     REFERENCES "Tag"("id")     ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Model3DEngagement"
    ADD CONSTRAINT "Model3DEngagement_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id")    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3DEngagement_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Model3DReport"
    ADD CONSTRAINT "Model3DReport_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3DReport_reportId_fkey"  FOREIGN KEY ("reportId")  REFERENCES "Report"("id")  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Model3DReview"
    ADD CONSTRAINT "Model3DReview_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3DReview_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id")    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Model3DReviewReport"
    ADD CONSTRAINT "Model3DReviewReport_model3dReviewId_fkey" FOREIGN KEY ("model3dReviewId") REFERENCES "Model3DReview"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "Model3DReviewReport_reportId_fkey"        FOREIGN KEY ("reportId")        REFERENCES "Report"("id")        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Model3DMetric"
    ADD CONSTRAINT "Model3DMetric_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Thread"
    ADD CONSTRAINT "Thread_model3dId_fkey"       FOREIGN KEY ("model3dId")       REFERENCES "Model3D"("id")       ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "Thread_model3dReviewId_fkey" FOREIGN KEY ("model3dReviewId") REFERENCES "Model3DReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Post"
    ADD CONSTRAINT "Post_model3dId_fkey"       FOREIGN KEY ("model3dId")       REFERENCES "Model3D"("id")       ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "Post_model3dReviewId_fkey" FOREIGN KEY ("model3dReviewId") REFERENCES "Model3DReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CollectionItem"
    ADD CONSTRAINT "CollectionItem_model3dId_fkey" FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------
-- 17. Seed: Model3DLicense templates
-- For `isCustom = true` rows, the boolean columns are advisory only —
-- the creator's free-text `Model3D.licenseDetails` is authoritative.
-- -----------------------------
INSERT INTO "Model3DLicense" ("name", "description", "allowCommercialUse", "allowPrintFarm", "allowDerivatives", "allowRedistribution", "requireAttribution", "isCustom") VALUES
    ('CC-BY 4.0',                'Creative Commons Attribution 4.0 — anyone may use commercially with attribution.', true,  true,  true,  true,  true,  false),
    ('CC-BY-NC 4.0',             'Creative Commons Attribution Non-Commercial 4.0 — non-commercial use with attribution.', false, false, true,  true,  true,  false),
    ('Personal Use Only',        'Free for personal use only. No commercial use, no redistribution.', false, false, false, false, true,  false),
    ('No Commercial Print Farm', 'Personal and commercial use allowed, but no commercial print-farm operations.', true,  false, true,  true,  true,  false),
    ('All Rights Reserved',      'Default restrictive license. No use, derivatives, or redistribution without explicit permission.', false, false, false, false, true,  false),
    ('Custom',                   'Custom license — see free-text licenseDetails on the model.', false, false, false, false, true,  true)
ON CONFLICT ("name") DO NOTHING;

-- -----------------------------
-- 18. Seed: starter Tag taxonomy for Model3D
-- Generic 3D tags — applicable to printing, games, animation, viz.
-- For names that already exist, append 'Model3D' to their target array.
-- -----------------------------
WITH starter_tags(name, is_category) AS (
    VALUES
        -- Subject
        ('character',    true),
        ('creature',     true),
        ('environment',  true),
        ('prop',         true),
        ('vehicle',      true),
        ('architecture', true),
        ('furniture',    true),
        -- Style
        ('low-poly',     false),
        ('stylized',     false),
        ('realistic',    false),
        ('abstract',     false),
        ('sci-fi',       false),
        ('fantasy',      false)
)
INSERT INTO "Tag" ("name", "target", "type", "isCategory", "createdAt", "updatedAt")
SELECT name, ARRAY['Model3D']::"TagTarget"[], 'System', is_category, NOW(), NOW()
FROM starter_tags
ON CONFLICT ("name") DO UPDATE
    SET "target" = CASE
        WHEN 'Model3D' = ANY("Tag"."target") THEN "Tag"."target"
        ELSE array_append("Tag"."target", 'Model3D'::"TagTarget")
    END;

COMMIT;
-- Transaction 2 committed. Migration complete.
