-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "earlyAccessDeadline" TIMESTAMP(3);

WITH ea_deadlines AS (
	SELECT
	  mv."modelId",
	  MAX("publishedAt" + INTERVAL '1 day' * "earlyAccessTimeFrame") deadline
	FROM "ModelVersion" mv
	WHERE "earlyAccessTimeFrame" > 0
	GROUP BY mv."modelId"
)
UPDATE "Model" m set "earlyAccessDeadline" = ed.deadline
FROM ea_deadlines ed
WHERE ed."modelId" = m.id AND ed.deadline > now();
