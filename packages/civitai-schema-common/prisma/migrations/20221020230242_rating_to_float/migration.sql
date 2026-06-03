-- Remove views
DROP VIEW public."ModelVersionRank";
DROP VIEW public."ModelRank";

-- AlterTable
ALTER TABLE "ModelMetric" ALTER COLUMN "rating" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ALTER COLUMN "rating" SET DATA TYPE DOUBLE PRECISION;

-- Re add views
CREATE OR REPLACE VIEW public."ModelVersionRank" AS
SELECT
t."modelVersionId",
MAX(iif(t.timeframe = 'Day', t."downloadCount", NULL)) "downloadCountDay",
MAX(iif(t.timeframe = 'Day', t."ratingCount", NULL)) "ratingCountDay",
MAX(iif(t.timeframe = 'Day', t."rating", NULL)) "ratingDay",
MAX(iif(t.timeframe = 'Week', t."downloadCount", NULL)) "downloadCountWeek",
MAX(iif(t.timeframe = 'Week', t."ratingCount", NULL)) "ratingCountWeek",
MAX(iif(t.timeframe = 'Week', t."rating", NULL)) "ratingWeek",
MAX(iif(t.timeframe = 'Month', t."downloadCount", NULL)) "downloadCountMonth",
MAX(iif(t.timeframe = 'Month', t."ratingCount", NULL)) "ratingCountMonth",
MAX(iif(t.timeframe = 'Month', t."rating", NULL)) "ratingMonth",
MAX(iif(t.timeframe = 'Year', t."downloadCount", NULL)) "downloadCountYear",
MAX(iif(t.timeframe = 'Year', t."ratingCount", NULL)) "ratingCountYear",
MAX(iif(t.timeframe = 'Year', t."rating", NULL)) "ratingYear",
MAX(iif(t.timeframe = 'AllTime', t."downloadCount", NULL)) "downloadCountAllTime",
MAX(iif(t.timeframe = 'AllTime', t."ratingCount", NULL)) "ratingCountAllTime",
MAX(iif(t.timeframe = 'AllTime', t."rating", NULL)) "ratingAllTime"
FROM (
	SELECT
	m.id "modelVersionId",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."downloadCount" DESC ) "downloadCount",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."ratingCount" DESC ) "ratingCount",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."rating" DESC ) rating,
	mm.timeframe
	FROM "ModelVersion" m
	JOIN "ModelVersionMetric" mm ON mm."modelVersionId" = m.id
) t
GROUP BY t."modelVersionId";

CREATE OR REPLACE VIEW public."ModelRank" AS
SELECT
t."modelId",
MAX(iif(t.timeframe = 'Day', t."downloadCount", NULL)) "downloadCountDay",
MAX(iif(t.timeframe = 'Day', t."ratingCount", NULL)) "ratingCountDay",
MAX(iif(t.timeframe = 'Day', t."rating", NULL)) "ratingDay",
MAX(iif(t.timeframe = 'Week', t."downloadCount", NULL)) "downloadCountWeek",
MAX(iif(t.timeframe = 'Week', t."ratingCount", NULL)) "ratingCountWeek",
MAX(iif(t.timeframe = 'Week', t."rating", NULL)) "ratingWeek",
MAX(iif(t.timeframe = 'Month', t."downloadCount", NULL)) "downloadCountMonth",
MAX(iif(t.timeframe = 'Month', t."ratingCount", NULL)) "ratingCountMonth",
MAX(iif(t.timeframe = 'Month', t."rating", NULL)) "ratingMonth",
MAX(iif(t.timeframe = 'Year', t."downloadCount", NULL)) "downloadCountYear",
MAX(iif(t.timeframe = 'Year', t."ratingCount", NULL)) "ratingCountYear",
MAX(iif(t.timeframe = 'Year', t."rating", NULL)) "ratingYear",
MAX(iif(t.timeframe = 'AllTime', t."downloadCount", NULL)) "downloadCountAllTime",
MAX(iif(t.timeframe = 'AllTime', t."ratingCount", NULL)) "ratingCountAllTime",
MAX(iif(t.timeframe = 'AllTime', t."rating", NULL)) "ratingAllTime"
FROM (
	SELECT
	m.id "modelId",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."downloadCount" DESC ) "downloadCount",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."ratingCount" DESC ) "ratingCount",
	RANK () OVER ( PARTITION BY mm.timeframe ORDER BY mm."rating" DESC ) rating,
	mm.timeframe
	FROM "Model" m
	JOIN "ModelMetric" mm ON mm."modelId" = m.id
) t
GROUP BY t."modelId";