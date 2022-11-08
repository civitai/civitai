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
		tf.timeframe
	FROM "ModelVersion" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelVersionMetric" mm ON mm."modelVersionId" = m.id
) t
GROUP BY t."modelVersionId";

CREATE OR REPLACE VIEW public."ModelRank"
AS
SELECT
	t."modelId",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::bigint)) AS "downloadCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::bigint)) AS "ratingCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t.rating, NULL::bigint)) AS "ratingDay",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::bigint)) AS "downloadCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::bigint)) AS "ratingCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t.rating, NULL::bigint)) AS "ratingWeek",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::bigint)) AS "downloadCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::bigint)) AS "ratingCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t.rating, NULL::bigint)) AS "ratingMonth",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::bigint)) AS "downloadCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::bigint)) AS "ratingCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t.rating, NULL::bigint)) AS "ratingYear",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::bigint)) AS "downloadCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::bigint)) AS "ratingCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t.rating, NULL::bigint)) AS "ratingAllTime"
FROM (
	SELECT
 		m.id AS "modelId",
		RANK() OVER (PARTITION BY mm.timeframe ORDER BY mm."downloadCount" DESC) AS "downloadCount",
		RANK() OVER (PARTITION BY mm.timeframe ORDER BY mm."ratingCount" DESC) AS "ratingCount",
		RANK() OVER (PARTITION BY mm.timeframe ORDER BY mm.rating DESC) AS rating,
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id
) t
GROUP BY t."modelId";