-- CreateEnum
CREATE TYPE "ImageGenerationProcess" AS ENUM ('txt2img', 'img2img', 'inpainting','txt2imgHiRes');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "generationProcess" "ImageGenerationProcess";

-- Set generationProcess
WITH image_props as (
  SELECT
	  id,
	  COALESCE(meta['Denoise strength'], meta['Denoising strength']) denoise,
	  COALESCE(meta['First pass strength'], meta['Hires upscale'], meta['Hires upscaler']) upscale,
	  meta['Mask blur'] mask
	FROM "Image"
	WHERE meta IS NOT NULL AND meta != '{}'
), image_gen_type as (
	SELECT
	  id,
	  CASE
	    WHEN mask IS NOT NULL THEN 'inpainting'
			WHEN denoise IS NOT NULL AND upscale IS NULL THEN 'img2img'
			WHEN denoise IS NOT NULL AND upscale IS NOT NULL THEN 'txt2imgHiRes'
			ELSE 'txt2img'
		END gen_type
	FROM image_props
)
UPDATE "Image" i
SET "generationProcess" = igt.gen_type::"ImageGenerationProcess"
FROM image_gen_type igt
WHERE i.id = igt.id;

-- Update stat view
CREATE OR REPLACE VIEW "ImageStat" AS
WITH timeframe_stats AS (
  SELECT
		i.id AS "imageId",
		COALESCE(mm."heartCount", 0) AS "heartCount",
		COALESCE(mm."likeCount", 0) AS "likeCount",
    COALESCE(mm."dislikeCount", 0) AS "dislikeCount",
    COALESCE(mm."laughCount", 0) AS "laughCount",
    COALESCE(mm."cryCount", 0) AS "cryCount",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		tf.timeframe
	FROM "Image" i
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ImageMetric" mm ON mm."imageId" = i.id AND mm.timeframe = tf.timeframe
)
SELECT
	"imageId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountAllTime"
FROM timeframe_stats ts
GROUP BY "imageId";

-- Add ImageModHelper
CREATE OR REPLACE VIEW "ImageModHelper" AS
with image_analysis AS (
	SELECT
	  id,
	  cast(analysis->'porn' as float4) porn,
	  cast(analysis->'sexy' as float4) sexy,
	  cast(analysis->'hentai' as float4) hentai,
	  cast(analysis->'drawing' as float4) drawing,
	  cast(analysis->'neutral' as float4) neutral
	FROM "Image"
	WHERE analysis IS NOT NULL AND analysis->>'neutral' != '0'
)
SELECT
  i.id "imageId",
  IIF(ia.id IS NOT NULL, ia.porn + ia.hentai + (ia.sexy/2) > 0.6, NULL) "assessedNSFW",
  COALESCE(reports.count, 0) "nsfwReportCount"
FROM "Image" i
LEFT JOIN image_analysis ia ON ia.id = i.id
LEFT JOIN (
  SELECT
	  ir."imageId",
	  COUNT(DISTINCT r."userId") count
	FROM "ImageReport" ir
	JOIN "Report" r ON r.id = ir."reportId"
	WHERE r.reason = 'NSFW'
	GROUP BY ir."imageId"
) reports ON reports."imageId" = i.id;