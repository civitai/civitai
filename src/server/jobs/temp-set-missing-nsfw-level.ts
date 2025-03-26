import { dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';

export const tempSetMissingNsfwLevel = createJob(
  'temp-set-missing-nsfw-level',
  '*/10 * * * *',
  async () => {
    const versions = await dbWrite.$queryRaw<{ id: number }[]>`
      WITH missing_level AS (
        SELECT id FROM "ModelVersion"
        WHERE status = 'Published' AND "nsfwLevel" = 0
      ), level as (
        SELECT
          mv.id,
          CASE
            WHEN m.nsfw = TRUE THEN 28
            -- WHEN m."userId" = -1 THEN (
            --   SELECT COALESCE(bit_or(ranked."nsfwLevel"), 0) "nsfwLevel"
            --   FROM (
            --     SELECT
            --     ir."imageId" id,
            --     ir."modelVersionId",
            --     row_number() OVER (PARTITION BY ir."modelVersionId" ORDER BY im."reactionCount" DESC) row_num,
            --     i."nsfwLevel"
            --     FROM "ImageResourceNew" ir
            --     JOIN "Image" i ON i.id = ir."imageId"
            --     JOIN "Post" p ON p.id = i."postId"
            --     JOIN "ImageMetric" im ON im."imageId" = ir."imageId" AND im.timeframe = 'AllTime'::"MetricTimeframe"
            --     WHERE ir."modelVersionId" = mv.id
            --     AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
            --   ) AS ranked
            --   WHERE ranked.row_num <= 20
            -- )
            WHEN m."userId" != -1 THEN (
              SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
              FROM (
                SELECT
                  i."nsfwLevel"
                FROM "Post" p
                JOIN "Image" i ON i."postId" = p.id
                WHERE p."modelVersionId" = mv.id
                AND p."userId" = m."userId"
                AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
                ORDER BY p."id", i."index"
                LIMIT 20
              ) AS i
            )
          END AS "nsfwLevel"
        FROM "ModelVersion" mv
        JOIN "Model" m ON mv."modelId" = m.id
        WHERE mv.id IN (110785)
      )
      UPDATE "ModelVersion" mv
      SET "nsfwLevel" = level."nsfwLevel"
      FROM level
      WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel"
      RETURNING mv.id;
    `;

    const models = await dbWrite.$queryRaw<{ id: number }[]>`
      WITH missing_level AS (
        SELECT id FROM "Model"
        WHERE status = 'Published' AND "nsfwLevel" = 0
      ), level AS (
        SELECT
          mv."modelId" as "id",
          bit_or(mv."nsfwLevel") "nsfwLevel"
        FROM "ModelVersion" mv
        WHERE mv."modelId" IN (SELECT id FROM missing_level)
        AND mv.status = 'Published'
        GROUP BY mv."modelId"
      )
      UPDATE "Model" m
      SET "nsfwLevel" = (
        CASE
          WHEN m.nsfw = TRUE THEN 28
          ELSE level."nsfwLevel"
        END
      ), "lastVersionAt" = now()
      FROM level
      WHERE
        level.id = m.id
        AND (level."nsfwLevel" != m."nsfwLevel")
        AND m."nsfwLevel" = 0
      RETURNING m.id;
    `;

    // Update old lastVersionAt
    const [lastRun, setLastRun] = await getJobDate('temp-set-missing-nsfw-level');
    await dbWrite.$executeRaw`
      WITH last_version AS (
        SELECT "modelId", max("publishedAt") "publishedAt"
        FROM "ModelVersion"
        WHERE status = 'Published' AND "publishedAt" >= ${lastRun}
        GROUP BY "modelId"
      )
      UPDATE "Model" m SET "lastVersionAt" = lv."publishedAt"
      FROM last_version lv
      WHERE lv."modelId" = m.id
      AND m."lastVersionAt" < lv."publishedAt";
    `;
    await setLastRun();

    // Update missing lastVersionAt
    await dbWrite.$executeRaw`
      WITH last_version AS (
        SELECT "modelId", max("publishedAt") "publishedAt"
        FROM "ModelVersion"
        WHERE status = 'Published'
        GROUP BY "modelId"
      )
      UPDATE "Model" m SET "lastVersionAt" = lv."publishedAt"
      FROM last_version lv
      WHERE lv."modelId" = m.id
      AND m."lastVersionAt" IS NULL;
    `;

    return {
      versions: versions.length,
      models: models.length,
    };
  }
);
