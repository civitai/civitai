-- ModelBaseModelMetric Table
-- Stores aggregated metrics per (modelId, baseModel) for efficient feed queries when filtering by base model
-- This prevents gaming where stats from SDXL/Pony versions inflate rankings in other base model feeds

-- Step 1: Create the table (indexes created after backfill for performance)
CREATE TABLE "ModelBaseModelMetric" (
  "modelId" INT NOT NULL,
  "baseModel" TEXT NOT NULL,
  -- Sort columns (aggregated from ModelVersionMetric)
  "thumbsUpCount" INT NOT NULL DEFAULT 0,
  "downloadCount" INT NOT NULL DEFAULT 0,
  "imageCount" INT NOT NULL DEFAULT 0,
  -- Denormalized filter columns (synced from Model via trigger)
  "status" "ModelStatus" NOT NULL DEFAULT 'Draft',
  "availability" "Availability" NOT NULL DEFAULT 'Public',
  "nsfwLevel" INT NOT NULL DEFAULT 0,
  "mode" "ModelModifier",
  "poi" BOOLEAN NOT NULL DEFAULT false,
  "minor" BOOLEAN NOT NULL DEFAULT false,
  -- Timestamps
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("modelId", "baseModel")
);

-- Step 2: Create trigger function to sync Model metadata to ModelBaseModelMetric
CREATE OR REPLACE FUNCTION sync_model_to_base_model_metric()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- On Model UPDATE, sync metadata to all ModelBaseModelMetric rows for this model
  IF (TG_OP = 'UPDATE') THEN
    UPDATE "ModelBaseModelMetric"
    SET
      "status" = NEW."status",
      "availability" = NEW."availability",
      "mode" = NEW."mode",
      "nsfwLevel" = NEW."nsfwLevel",
      "minor" = NEW."minor",
      "poi" = NEW."poi",
      "updatedAt" = NOW()
    WHERE "modelId" = NEW.id;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$function$;

-- Step 3: Create trigger on Model for metadata sync
CREATE TRIGGER trg_sync_model_to_base_model_metric
AFTER UPDATE ON "Model"
FOR EACH ROW
WHEN (
  OLD."status" IS DISTINCT FROM NEW."status" OR
  OLD."availability" IS DISTINCT FROM NEW."availability" OR
  OLD."mode" IS DISTINCT FROM NEW."mode" OR
  OLD."nsfwLevel" IS DISTINCT FROM NEW."nsfwLevel" OR
  OLD."minor" IS DISTINCT FROM NEW."minor" OR
  OLD."poi" IS DISTINCT FROM NEW."poi"
)
EXECUTE FUNCTION sync_model_to_base_model_metric();

-- Step 4: Create trigger function to create ModelBaseModelMetric row when ModelVersion is published
CREATE OR REPLACE FUNCTION create_base_model_metric_on_version_publish()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only act when version becomes Published
  IF (NEW."status" = 'Published' AND (TG_OP = 'INSERT' OR OLD."status" != 'Published')) THEN
    -- Insert row if it doesn't exist, copying metadata from Model
    INSERT INTO "ModelBaseModelMetric" (
      "modelId",
      "baseModel",
      "thumbsUpCount",
      "downloadCount",
      "imageCount",
      "status",
      "availability",
      "mode",
      "nsfwLevel",
      "minor",
      "poi",
      "updatedAt"
    )
    SELECT
      NEW."modelId",
      NEW."baseModel",
      0, 0, 0, -- Stats start at 0, will be populated by metrics job
      m."status",
      m."availability",
      m."mode",
      m."nsfwLevel",
      m."minor",
      m."poi",
      NOW()
    FROM "Model" m
    WHERE m.id = NEW."modelId"
    ON CONFLICT ("modelId", "baseModel") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

-- Step 5: Create trigger on ModelVersion for row creation
CREATE TRIGGER trg_create_base_model_metric_on_version_publish
AFTER INSERT OR UPDATE ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION create_base_model_metric_on_version_publish();

-- Step 6: Backfill existing data
-- This aggregates metrics into the new table
-- Note: thumbsUpCount uses unique user count from ResourceReview (not sum of version counts)
-- while downloadCount and imageCount are summed from version metrics
INSERT INTO "ModelBaseModelMetric" (
  "modelId",
  "baseModel",
  "thumbsUpCount",
  "downloadCount",
  "imageCount",
  "status",
  "availability",
  "mode",
  "nsfwLevel",
  "minor",
  "poi",
  "updatedAt"
)
SELECT
  base_stats."modelId",
  base_stats."baseModel",
  COALESCE(review_stats."thumbsUpCount", 0) as "thumbsUpCount",
  base_stats."downloadCount",
  base_stats."imageCount",
  base_stats."status",
  base_stats."availability",
  base_stats."mode",
  base_stats."nsfwLevel",
  base_stats."minor",
  base_stats."poi",
  NOW()
FROM (
  -- Aggregate downloadCount and imageCount from version metrics (sum is correct here)
  SELECT
    mv."modelId",
    mv."baseModel",
    COALESCE(SUM(mvm."downloadCount"), 0) as "downloadCount",
    COALESCE(SUM(mvm."imageCount"), 0) as "imageCount",
    m."status",
    m."availability",
    m."mode",
    m."nsfwLevel",
    m."minor",
    m."poi"
  FROM "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
  LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
  WHERE mv."status" = 'Published'
  GROUP BY mv."modelId", mv."baseModel", m."status", m."availability", m."mode", m."nsfwLevel", m."minor", m."poi"
) base_stats
LEFT JOIN (
  -- Count unique users for thumbsUp per (modelId, baseModel)
  SELECT
    mv."modelId",
    mv."baseModel",
    COUNT(DISTINCT r."userId") FILTER (WHERE r.recommended = true) as "thumbsUpCount"
  FROM "ResourceReview" r
  JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
  WHERE r.exclude = false
    AND r."tosViolation" = false
    AND mv."status" = 'Published'
  GROUP BY mv."modelId", mv."baseModel"
) review_stats ON review_stats."modelId" = base_stats."modelId" AND review_stats."baseModel" = base_stats."baseModel"
ON CONFLICT ("modelId", "baseModel") DO UPDATE
SET
  "thumbsUpCount" = EXCLUDED."thumbsUpCount",
  "downloadCount" = EXCLUDED."downloadCount",
  "imageCount" = EXCLUDED."imageCount",
  "status" = EXCLUDED."status",
  "availability" = EXCLUDED."availability",
  "mode" = EXCLUDED."mode",
  "nsfwLevel" = EXCLUDED."nsfwLevel",
  "minor" = EXCLUDED."minor",
  "poi" = EXCLUDED."poi",
  "updatedAt" = NOW();

-- Step 7: Create covering indexes AFTER backfill for better performance
-- HighestRated / MostLiked: ORDER BY thumbsUpCount DESC, downloadCount DESC, modelId
CREATE INDEX mbmm_feed_highest_rated
ON "ModelBaseModelMetric" (
  "baseModel",
  "thumbsUpCount" DESC,
  "downloadCount" DESC,
  "modelId"
) INCLUDE (
  "imageCount",
  "status",
  "availability",
  "nsfwLevel",
  "mode",
  "poi",
  "minor"
);

-- MostDownloaded: ORDER BY downloadCount DESC, thumbsUpCount DESC, modelId
CREATE INDEX mbmm_feed_most_downloaded
ON "ModelBaseModelMetric" (
  "baseModel",
  "downloadCount" DESC,
  "thumbsUpCount" DESC,
  "modelId"
) INCLUDE (
  "imageCount",
  "status",
  "availability",
  "nsfwLevel",
  "mode",
  "poi",
  "minor"
);

-- ImageCount: ORDER BY imageCount DESC, thumbsUpCount DESC, modelId
CREATE INDEX mbmm_feed_image_count
ON "ModelBaseModelMetric" (
  "baseModel",
  "imageCount" DESC,
  "thumbsUpCount" DESC,
  "modelId"
) INCLUDE (
  "downloadCount",
  "status",
  "availability",
  "nsfwLevel",
  "mode",
  "poi",
  "minor"
);

-- Step 8: Fix thumbsUpCount to use unique user counts
-- Run this separately if migration was previously run with summed counts
-- Only thumbsUpCount needs deduping - downloads and images are correctly summed per version
UPDATE "ModelBaseModelMetric" mbm
SET
  "thumbsUpCount" = COALESCE(review_stats."thumbsUpCount", 0),
  "updatedAt" = NOW()
FROM (
  SELECT
    mv."modelId",
    mv."baseModel",
    COUNT(DISTINCT r."userId") FILTER (WHERE r.recommended = true) as "thumbsUpCount"
  FROM "ResourceReview" r
  JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
  WHERE r.exclude = false
    AND r."tosViolation" = false
    AND mv."status" = 'Published'
  GROUP BY mv."modelId", mv."baseModel"
) review_stats
WHERE mbm."modelId" = review_stats."modelId"
  AND mbm."baseModel" = review_stats."baseModel";
