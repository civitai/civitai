import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('update-metrics', 'blue');

const METRIC_LAST_UPDATED_KEY = 'last-metrics-update';
const RANK_LAST_UPDATED_KEY = 'last-rank-update';
const RANK_UPDATE_DELAY = 1000 * 60 * 60; // 60 minutes

export const updateMetricsJob = createJob(
  'update-metrics',
  '*/1 * * * *',
  async () => {
    // Get the last time this ran from the KeyValue store
    // --------------------------------------
    const dates = await dbWrite.keyValue.findMany({
      where: { key: { in: [METRIC_LAST_UPDATED_KEY, RANK_LAST_UPDATED_KEY] } },
    });
    const lastUpdateDate = new Date(
      (dates.find((d) => d.key === METRIC_LAST_UPDATED_KEY)?.value as number) ?? 0
    );
    const lastRankDate = new Date(
      (dates?.find((d) => d.key === RANK_LAST_UPDATED_KEY)?.value as number) ?? 0
    );
    const lastUpdate = lastUpdateDate.toISOString();

    const updateModelMetrics = async (target: 'models' | 'versions') => {
      const [tableName, tableId, viewName, viewId] =
        target === 'models'
          ? ['ModelMetric', 'modelId', 'affected_models', 'model_id']
          : ['ModelVersionMetric', 'modelVersionId', 'affected_versions', 'model_version_id'];

      await dbWrite.$executeRawUnsafe(`
        -- Get all user activities that have happened since then that affect metrics
        WITH recent_activities AS
        (
          SELECT
            CAST(a.details ->> 'modelId' AS INT) AS model_id,
            CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id
          FROM "UserActivity" a
          WHERE (a."createdAt" > '${lastUpdate}')
          AND (a.activity IN ('ModelDownload'))

          UNION

          SELECT muq.id AS model_id, mv.id AS model_version_id
          FROM "MetricUpdateQueue" muq
          JOIN "ModelVersion" mv ON mv."modelId" = muq.id
          WHERE type = 'Model'
        ),
        -- Get all reviews that have been created/updated since then
        recent_reviews AS
        (
          SELECT
            r."modelId" AS model_id,
            r."modelVersionId" AS model_version_id
          FROM "Review" r
          WHERE (r."createdAt" > '${lastUpdate}' OR r."updatedAt" > '${lastUpdate}')
        ),
        -- Get all favorites that have been created since then
        recent_favorites AS
        (
          SELECT
            "modelId" AS model_id
          FROM "ModelEngagement"
          WHERE ("createdAt" > '${lastUpdate}') AND type = 'Favorite'
        ),
        -- Get all comments that have been created since then
        recent_comments AS
        (
          SELECT
            "modelId" AS model_id
          FROM "Comment"
          WHERE ("createdAt" > '${lastUpdate}')
        ),
        -- Get all affected models
        affected_models AS
        (
            SELECT DISTINCT
                r.model_id
            FROM recent_reviews r
            WHERE r.model_id IS NOT NULL

            UNION

            SELECT DISTINCT
                f.model_id
            FROM recent_favorites f

            UNION

            SELECT DISTINCT
                c.model_id
            FROM recent_comments c

            UNION

            SELECT DISTINCT
                a.model_id
            FROM recent_activities a
            JOIN "Model" m ON m.Id = a.model_id
            WHERE a.model_id IS NOT NULL
        ),
        -- Get all affected versions
        affected_versions AS
        (
            SELECT DISTINCT
                r.model_version_id,
                r.model_id
            FROM recent_reviews r
            WHERE r.model_version_id IS NOT NULL

            UNION

            SELECT DISTINCT
                a.model_version_id,
                a.model_id
            FROM recent_activities a
            JOIN "ModelVersion" m ON m.Id = a.model_version_id
            WHERE a.model_version_id IS NOT NULL
        )

        -- upsert metrics for all affected models
        -- perform a one-pass table scan producing all metrics for all affected models
        INSERT INTO "${tableName}" ("${tableId}", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
        SELECT
          m.${viewId},
          tf.timeframe,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN download_count
            WHEN tf.timeframe = 'Year' THEN year_download_count
            WHEN tf.timeframe = 'Month' THEN month_download_count
            WHEN tf.timeframe = 'Week' THEN week_download_count
            WHEN tf.timeframe = 'Day' THEN day_download_count
          END AS download_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN rating_count
            WHEN tf.timeframe = 'Year' THEN year_rating_count
            WHEN tf.timeframe = 'Month' THEN month_rating_count
            WHEN tf.timeframe = 'Week' THEN week_rating_count
            WHEN tf.timeframe = 'Day' THEN day_rating_count
          END AS rating_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN rating
            WHEN tf.timeframe = 'Year' THEN year_rating
            WHEN tf.timeframe = 'Month' THEN month_rating
            WHEN tf.timeframe = 'Week' THEN week_rating
            WHEN tf.timeframe = 'Day' THEN day_rating
          END AS rating,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN favorite_count
            WHEN tf.timeframe = 'Year' THEN year_favorite_count
            WHEN tf.timeframe = 'Month' THEN month_favorite_count
            WHEN tf.timeframe = 'Week' THEN week_favorite_count
            WHEN tf.timeframe = 'Day' THEN day_favorite_count
          END AS favorite_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN comment_count
            WHEN tf.timeframe = 'Year' THEN year_comment_count
            WHEN tf.timeframe = 'Month' THEN month_comment_count
            WHEN tf.timeframe = 'Week' THEN week_comment_count
            WHEN tf.timeframe = 'Day' THEN day_comment_count
          END AS comment_count
        FROM
        (
          SELECT
            m.${viewId},
            COALESCE(ds.download_count, 0) AS download_count,
            COALESCE(ds.year_download_count, 0) AS year_download_count,
            COALESCE(ds.month_download_count, 0) AS month_download_count,
            COALESCE(ds.week_download_count, 0) AS week_download_count,
            COALESCE(ds.day_download_count, 0) AS day_download_count,
            COALESCE(rs.rating_count, 0) AS rating_count,
            COALESCE(rs.rating, 0) AS rating,
            COALESCE(rs.year_rating_count, 0) AS year_rating_count,
            COALESCE(rs.year_rating, 0) AS year_rating,
            COALESCE(rs.month_rating_count, 0) AS month_rating_count,
            COALESCE(rs.month_rating, 0) AS month_rating,
            COALESCE(rs.week_rating_count, 0) AS week_rating_count,
            COALESCE(rs.week_rating, 0) AS week_rating,
            COALESCE(rs.day_rating_count, 0) AS day_rating_count,
            COALESCE(rs.day_rating, 0) AS day_rating,
            COALESCE(fs.favorite_count, 0) AS favorite_count,
            COALESCE(fs.year_favorite_count, 0) AS year_favorite_count,
            COALESCE(fs.month_favorite_count, 0) AS month_favorite_count,
            COALESCE(fs.week_favorite_count, 0) AS week_favorite_count,
            COALESCE(fs.day_favorite_count, 0) AS day_favorite_count,
            COALESCE(cs.comment_count, 0) AS comment_count,
            COALESCE(cs.year_comment_count, 0) AS year_comment_count,
            COALESCE(cs.month_comment_count, 0) AS month_comment_count,
            COALESCE(cs.week_comment_count, 0) AS week_comment_count,
            COALESCE(cs.day_comment_count, 0) AS day_comment_count
          FROM ${viewName} m
          LEFT JOIN (
            SELECT
              a.${viewId},
              COUNT(a.${viewId}) AS download_count,
              SUM(CASE WHEN a.created_at >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_download_count,
              SUM(CASE WHEN a.created_at >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_download_count,
              SUM(CASE WHEN a.created_at >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_download_count,
              SUM(CASE WHEN a.created_at >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_download_count
            FROM
            (
              SELECT
                user_id,
                ${viewId},
                MAX(created_at) created_at
              FROM (
                SELECT
                  COALESCE(CAST(a."userId" as text), a.details->>'ip') user_id,
                  CAST(a.details ->> '${tableId}' AS INT) AS ${viewId},
                  a."createdAt" AS created_at
                FROM "UserActivity" a
              ) t
              GROUP BY user_id, ${viewId}
            ) a
            GROUP BY a.${viewId}
          ) ds ON m.${viewId} = ds.${viewId}
          LEFT JOIN (
            SELECT
              r.${viewId},
              COUNT(r.${viewId}) AS rating_count,
              AVG(r.rating) AS rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '365 days') THEN r.rating ELSE NULL END) AS year_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '30 days') THEN r.rating ELSE NULL END) AS month_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '7 days') THEN r.rating ELSE NULL END) AS week_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '1 days') THEN r.rating ELSE NULL END) AS day_rating
            FROM
            (
              SELECT
                r."userId",
                r."${tableId}" AS ${viewId},
                MAX(r.rating) rating,
                MAX(r."createdAt") AS created_at
              FROM "Review" r
              JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
              WHERE r.exclude = FALSE AND r."tosViolation" = FALSE
              GROUP BY r."userId", r."${tableId}"
            ) r
            GROUP BY r.${viewId}
          ) rs ON m.${viewId} = rs.${viewId}
          LEFT JOIN (
            SELECT
              f."modelId" AS model_id,
              COUNT(f."modelId") AS favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_favorite_count
            FROM "ModelEngagement" f
            WHERE type = 'Favorite'
            GROUP BY f."modelId"
          ) fs ON m.model_id = fs.model_id
          LEFT JOIN (
            SELECT
              "modelId" AS model_id,
              COUNT("modelId") AS comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_comment_count
            FROM "Comment"
            WHERE "tosViolation" = FALSE
            GROUP BY "modelId"
          ) cs ON m.model_id = cs.model_id
        ) m
        CROSS JOIN (
          SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
        ) tf
        ON CONFLICT ("${tableId}", timeframe) DO UPDATE
          SET "downloadCount" = EXCLUDED."downloadCount", "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating, "favoriteCount" = EXCLUDED."favoriteCount", "commentCount" = EXCLUDED."commentCount";
        `);

      if (target === 'versions')
        await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Model'`);
    };

    const updateUserMetrics = async () => {
      await dbWrite.$executeRawUnsafe(`
      WITH recent_engagements AS
      (
        SELECT
          a."userId" AS user_id
        FROM "UserEngagement" a
        WHERE (a."createdAt" > '${lastUpdate}')

        UNION

        SELECT
          a."targetUserId" AS user_id
        FROM "UserEngagement" a
        WHERE (a."createdAt" > '${lastUpdate}')

        UNION

        SELECT
          "userId"
        FROM "ModelVersion" mv
        JOIN "Model" m ON mv."modelId" = m.id
        WHERE (mv."createdAt" > '${lastUpdate}' OR m."publishedAt" > '${lastUpdate}')

        UNION

        SELECT
          "userId"
        FROM "Review" r
        WHERE (r."createdAt" > '${lastUpdate}')

        UNION

        SELECT
          a2."userId"
        FROM "AnswerVote" ar
        JOIN "Answer" a2 ON a2.id = ar."answerId"
        WHERE (ar."createdAt" > '${lastUpdate}')

        UNION

        SELECT
          "userId"
        FROM "Answer" ar
        WHERE "createdAt" > '${lastUpdate}'

        UNION

        SELECT
          "id"
        FROM "MetricUpdateQueue"
        WHERE type = 'User'
      ),
      -- Get all affected users
      affected_users AS
      (
          SELECT DISTINCT
              r.user_id
          FROM recent_engagements r
          WHERE r.user_id IS NOT NULL
      )

      -- upsert metrics for all affected users
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "UserMetric" ("userId", timeframe, "followingCount", "followerCount", "hiddenCount", "uploadCount", "reviewCount", "answerCount", "answerAcceptCount")
      SELECT
        m.user_id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN following_count
          WHEN tf.timeframe = 'Year' THEN year_following_count
          WHEN tf.timeframe = 'Month' THEN month_following_count
          WHEN tf.timeframe = 'Week' THEN week_following_count
          WHEN tf.timeframe = 'Day' THEN day_following_count
        END AS following_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN follower_count
          WHEN tf.timeframe = 'Year' THEN year_follower_count
          WHEN tf.timeframe = 'Month' THEN month_follower_count
          WHEN tf.timeframe = 'Week' THEN week_follower_count
          WHEN tf.timeframe = 'Day' THEN day_follower_count
        END AS follower_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN hidden_count
          WHEN tf.timeframe = 'Year' THEN year_hidden_count
          WHEN tf.timeframe = 'Month' THEN month_hidden_count
          WHEN tf.timeframe = 'Week' THEN week_hidden_count
          WHEN tf.timeframe = 'Day' THEN day_hidden_count
        END AS hidden_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN upload_count
          WHEN tf.timeframe = 'Year' THEN year_upload_count
          WHEN tf.timeframe = 'Month' THEN month_upload_count
          WHEN tf.timeframe = 'Week' THEN week_upload_count
          WHEN tf.timeframe = 'Day' THEN day_upload_count
        END AS upload_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN review_count
          WHEN tf.timeframe = 'Year' THEN year_review_count
          WHEN tf.timeframe = 'Month' THEN month_review_count
          WHEN tf.timeframe = 'Week' THEN week_review_count
          WHEN tf.timeframe = 'Day' THEN day_review_count
        END AS review_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN answer_count
          WHEN tf.timeframe = 'Year' THEN year_answer_count
          WHEN tf.timeframe = 'Month' THEN month_answer_count
          WHEN tf.timeframe = 'Week' THEN week_answer_count
          WHEN tf.timeframe = 'Day' THEN day_answer_count
        END AS answer_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN check_count
          WHEN tf.timeframe = 'Year' THEN year_check_count
          WHEN tf.timeframe = 'Month' THEN month_check_count
          WHEN tf.timeframe = 'Week' THEN week_check_count
          WHEN tf.timeframe = 'Day' THEN day_check_count
        END AS check_count
      FROM
      (
        SELECT
          a.user_id,
          COALESCE(fs.following_count, 0) AS following_count,
          COALESCE(fs.year_following_count, 0) AS year_following_count,
          COALESCE(fs.month_following_count, 0) AS month_following_count,
          COALESCE(fs.week_following_count, 0) AS week_following_count,
          COALESCE(fs.day_following_count, 0) AS day_following_count,
          COALESCE(ft.follower_count, 0) AS follower_count,
          COALESCE(ft.year_follower_count, 0) AS year_follower_count,
          COALESCE(ft.month_follower_count, 0) AS month_follower_count,
          COALESCE(ft.week_follower_count, 0) AS week_follower_count,
          COALESCE(ft.day_follower_count, 0) AS day_follower_count,
          COALESCE(ft.hidden_count, 0) AS hidden_count,
          COALESCE(ft.year_hidden_count, 0) AS year_hidden_count,
          COALESCE(ft.month_hidden_count, 0) AS month_hidden_count,
          COALESCE(ft.week_hidden_count, 0) AS week_hidden_count,
          COALESCE(ft.day_hidden_count, 0) AS day_hidden_count,
          COALESCE(u.upload_count, 0) AS upload_count,
          COALESCE(u.year_upload_count, 0) AS year_upload_count,
          COALESCE(u.month_upload_count, 0) AS month_upload_count,
          COALESCE(u.week_upload_count, 0) AS week_upload_count,
          COALESCE(u.day_upload_count, 0) AS day_upload_count,
          COALESCE(r.review_count, 0) AS review_count,
          COALESCE(r.year_review_count, 0) AS year_review_count,
          COALESCE(r.month_review_count, 0) AS month_review_count,
          COALESCE(r.week_review_count, 0) AS week_review_count,
          COALESCE(r.day_review_count, 0) AS day_review_count,
          COALESCE(ans.answer_count, 0) AS answer_count,
          COALESCE(ans.year_answer_count, 0) AS year_answer_count,
          COALESCE(ans.month_answer_count, 0) AS month_answer_count,
          COALESCE(ans.week_answer_count, 0) AS week_answer_count,
          COALESCE(ans.day_answer_count, 0) AS day_answer_count,
          COALESCE(ans.check_count, 0) AS check_count,
          COALESCE(ans.year_check_count, 0) AS year_check_count,
          COALESCE(ans.month_check_count, 0) AS month_check_count,
          COALESCE(ans.week_check_count, 0) AS week_check_count,
          COALESCE(ans.day_check_count, 0) AS day_check_count
        FROM affected_users a
        LEFT JOIN (
          SELECT
            ue."userId" AS user_id,
            SUM(IIF(ue.type = 'Follow', 1, 0)) AS following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_following_count
          FROM "UserEngagement" ue
          GROUP BY ue."userId"
        ) fs ON a.user_id = fs.user_id
        LEFT JOIN (
          SELECT
            ans."userId" AS user_id,
            COUNT(*) answer_count,
            SUM(IIF(ans."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_answer_count,
            SUM(IIF(ans."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_answer_count,
            SUM(IIF(ans."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_answer_count,
            SUM(IIF(ans."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_answer_count,
            SUM(ar."checkCountAllTime") check_count,
            SUM(ar."checkCountDay") day_check_count,
            SUM(ar."checkCountWeek") week_check_count,
            SUM(ar."checkCountMonth") month_check_count,
            SUM(ar."checkCountYear") year_check_count
          FROM "AnswerRank" ar
          JOIN "Answer" ans ON ans.id = ar."answerId"
          GROUP BY ans."userId"
        ) ans ON a.user_id = ans.user_id
        LEFT JOIN (
          SELECT
            m2."userId" user_id,
            COUNT(*) upload_count,
            SUM(IIF(mv."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_upload_count,
            SUM(IIF(mv."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_upload_count,
            SUM(IIF(mv."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_upload_count,
            SUM(IIF(mv."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_upload_count
          FROM "ModelVersion" mv
          JOIN "Model" m2 ON mv."modelId" = m2.id
          WHERE m2.status = 'Published'
          GROUP BY m2."userId"
        ) u ON u.user_id = a.user_id
        LEFT JOIN (
          SELECT
            "userId" user_id,
            COUNT(*) review_count,
            SUM(IIF("createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_review_count,
            SUM(IIF("createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_review_count,
            SUM(IIF("createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_review_count,
            SUM(IIF("createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_review_count
          FROM "Review"
          GROUP BY "userId"
        ) r ON r.user_id = a.user_id
        LEFT JOIN (
          SELECT
            ue."targetUserId"                                                                      AS user_id,
            SUM(IIF(ue.type = 'Follow', 1, 0))                                                     AS follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0))  AS month_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0))   AS week_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0))   AS day_follower_count,
            SUM(IIF(ue.type = 'Hide', 1, 0))                                                       AS hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0))   AS year_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0))    AS month_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0))     AS week_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0))     AS day_hidden_count
          FROM "UserEngagement" ue
          GROUP BY ue."targetUserId"
        ) ft ON a.user_id = ft.user_id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "followingCount" = EXCLUDED."followingCount", "hiddenCount" = EXCLUDED."hiddenCount", "uploadCount" = EXCLUDED."uploadCount", "reviewCount" = EXCLUDED."reviewCount", "answerCount" = EXCLUDED."answerCount", "answerAcceptCount" = EXCLUDED."answerAcceptCount";
    `);
      await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'User'`);
    };

    const updateQuestionMetrics = async () => {
      await dbWrite.$executeRawUnsafe(`
      WITH recent_engagements AS
      (
        SELECT
          "questionId" AS id
        FROM "QuestionReaction"
        WHERE "createdAt" > '${lastUpdate}'

        UNION

        SELECT
          a."questionId" AS id
        FROM "Answer" a
        WHERE (a."createdAt" > '${lastUpdate}')

        UNION

        SELECT t."questionId" as id
        FROM "Thread" t
        JOIN "CommentV2" c ON c."threadId" = t.id
        WHERE t."questionId" IS NOT NULL AND c."createdAt" > '${lastUpdate}'

        UNION

        SELECT
          "id"
        FROM "MetricUpdateQueue"
        WHERE type = 'Question'
      ),
      -- Get all affected users
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          WHERE r.id IS NOT NULL
          AND r.id IN (SELECT id FROM "Question")
      )

      -- upsert metrics for all affected users
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "QuestionMetric" ("questionId", timeframe, "heartCount", "commentCount", "answerCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN heart_count
          WHEN tf.timeframe = 'Year' THEN year_heart_count
          WHEN tf.timeframe = 'Month' THEN month_heart_count
          WHEN tf.timeframe = 'Week' THEN week_heart_count
          WHEN tf.timeframe = 'Day' THEN day_heart_count
        END AS heart_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN comment_count
          WHEN tf.timeframe = 'Year' THEN year_comment_count
          WHEN tf.timeframe = 'Month' THEN month_comment_count
          WHEN tf.timeframe = 'Week' THEN week_comment_count
          WHEN tf.timeframe = 'Day' THEN day_comment_count
        END AS comment_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN answer_count
          WHEN tf.timeframe = 'Year' THEN year_answer_count
          WHEN tf.timeframe = 'Month' THEN month_answer_count
          WHEN tf.timeframe = 'Week' THEN week_answer_count
          WHEN tf.timeframe = 'Day' THEN day_answer_count
        END AS answer_count
      FROM
      (
        SELECT
          q.id,
          COALESCE(r.heart_count, 0) AS heart_count,
          COALESCE(r.year_heart_count, 0) AS year_heart_count,
          COALESCE(r.month_heart_count, 0) AS month_heart_count,
          COALESCE(r.week_heart_count, 0) AS week_heart_count,
          COALESCE(r.day_heart_count, 0) AS day_heart_count,
          COALESCE(c.comment_count, 0) AS comment_count,
          COALESCE(c.year_comment_count, 0) AS year_comment_count,
          COALESCE(c.month_comment_count, 0) AS month_comment_count,
          COALESCE(c.week_comment_count, 0) AS week_comment_count,
          COALESCE(c.day_comment_count, 0) AS day_comment_count,
          COALESCE(a.answer_count, 0) AS answer_count,
          COALESCE(a.year_answer_count, 0) AS year_answer_count,
          COALESCE(a.month_answer_count, 0) AS month_answer_count,
          COALESCE(a.week_answer_count, 0) AS week_answer_count,
          COALESCE(a.day_answer_count, 0) AS day_answer_count
        FROM affected q
        LEFT JOIN (
          SELECT
            a."questionId" AS id,
            COUNT(*) AS answer_count,
            SUM(IIF(a."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_answer_count,
            SUM(IIF(a."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_answer_count,
            SUM(IIF(a."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_answer_count,
            SUM(IIF(a."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_answer_count
          FROM "Answer" a
          GROUP BY a."questionId"
        ) a ON q.id = a.id
        LEFT JOIN (
          SELECT
            qc."questionId" AS id,
            COUNT(*) AS comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
          FROM "Thread" qc
          JOIN "CommentV2" v ON qc."id" = v."threadId"
          WHERE qc."questionId" IS NOT NULL
          GROUP BY qc."questionId"
        ) c ON q.id = c.id
        LEFT JOIN (
          SELECT
            qr."questionId" AS id,
            SUM(IIF(qr.reaction = 'Heart', 1, 0)) AS heart_count,
            SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
            SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
            SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
            SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count
          FROM "QuestionReaction" qr
          GROUP BY qr."questionId"
        ) r ON q.id = r.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("questionId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "answerCount" = EXCLUDED."answerCount";
    `);
      await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Question'`);
    };

    const updateAnswerMetrics = async () => {
      await dbWrite.$executeRawUnsafe(`
      WITH recent_engagements AS
      (
        SELECT
          "answerId" AS id
        FROM "AnswerReaction"
        WHERE "createdAt" > '${lastUpdate}'

        UNION

        SELECT t."answerId" as id
        FROM "Thread" t
        JOIN "CommentV2" c ON c."threadId" = t.id
        WHERE t."answerId" IS NOT NULL
        AND c."createdAt" > '${lastUpdate}'

        UNION

        SELECT
          "answerId" AS id
        FROM "AnswerVote"
        WHERE "createdAt" > '${lastUpdate}'

        UNION

        SELECT
          "id"
        FROM "MetricUpdateQueue"
        WHERE type = 'Answer'
      ),
      -- Get all affected users
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          WHERE r.id IS NOT NULL
          AND r.id IN (SELECT id FROM "Answer")
      )

      -- upsert metrics for all affected users
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "AnswerMetric" ("answerId", timeframe, "heartCount", "checkCount", "crossCount", "commentCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN heart_count
          WHEN tf.timeframe = 'Year' THEN year_heart_count
          WHEN tf.timeframe = 'Month' THEN month_heart_count
          WHEN tf.timeframe = 'Week' THEN week_heart_count
          WHEN tf.timeframe = 'Day' THEN day_heart_count
        END AS heart_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN check_count
          WHEN tf.timeframe = 'Year' THEN year_check_count
          WHEN tf.timeframe = 'Month' THEN month_check_count
          WHEN tf.timeframe = 'Week' THEN week_check_count
          WHEN tf.timeframe = 'Day' THEN day_check_count
        END AS check_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN cross_count
          WHEN tf.timeframe = 'Year' THEN year_cross_count
          WHEN tf.timeframe = 'Month' THEN month_cross_count
          WHEN tf.timeframe = 'Week' THEN week_cross_count
          WHEN tf.timeframe = 'Day' THEN day_cross_count
        END AS cross_count,
        CASE
            WHEN tf.timeframe = 'AllTime' THEN comment_count
            WHEN tf.timeframe = 'Year' THEN year_comment_count
            WHEN tf.timeframe = 'Month' THEN month_comment_count
            WHEN tf.timeframe = 'Week' THEN week_comment_count
            WHEN tf.timeframe = 'Day' THEN day_comment_count
          END AS comment_count
      FROM
      (
        SELECT
          q.id,
          COALESCE(c.comment_count, 0) AS comment_count,
          COALESCE(c.year_comment_count, 0) AS year_comment_count,
          COALESCE(c.month_comment_count, 0) AS month_comment_count,
          COALESCE(c.week_comment_count, 0) AS week_comment_count,
          COALESCE(c.day_comment_count, 0) AS day_comment_count,
          COALESCE(r.heart_count, 0) AS heart_count,
          COALESCE(r.year_heart_count, 0) AS year_heart_count,
          COALESCE(r.month_heart_count, 0) AS month_heart_count,
          COALESCE(r.week_heart_count, 0) AS week_heart_count,
          COALESCE(r.day_heart_count, 0) AS day_heart_count,
          COALESCE(v.check_count, 0) AS check_count,
          COALESCE(v.year_check_count, 0) AS year_check_count,
          COALESCE(v.month_check_count, 0) AS month_check_count,
          COALESCE(v.week_check_count, 0) AS week_check_count,
          COALESCE(v.day_check_count, 0) AS day_check_count,
          COALESCE(v.cross_count, 0) AS cross_count,
          COALESCE(v.year_cross_count, 0) AS year_cross_count,
          COALESCE(v.month_cross_count, 0) AS month_cross_count,
          COALESCE(v.week_cross_count, 0) AS week_cross_count,
          COALESCE(v.day_cross_count, 0) AS day_cross_count
        FROM affected q
        LEFT JOIN (
          SELECT
            ac."answerId" AS id,
            COUNT(*) AS comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
          FROM "Thread" ac
          JOIN "CommentV2" v ON ac."id" = v."threadId"
          WHERE ac."answerId" IS NOT NULL
          GROUP BY ac."answerId"
        ) c ON q.id = c.id
        LEFT JOIN (
          SELECT
            av."answerId" AS id,
            COUNT(*) AS vote_count,
            SUM(IIF(av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_vote_count,
            SUM(IIF(av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_vote_count,
            SUM(IIF(av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_vote_count,
            SUM(IIF(av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_vote_count,
            SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS check_count,
            SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_check_count,
            SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_check_count,
            SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_check_count,
            SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_check_count,
            SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS cross_count,
            SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cross_count,
            SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cross_count,
            SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cross_count,
            SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cross_count
          FROM "AnswerVote" av
          GROUP BY av."answerId"
        ) v ON v.id = q.id
        LEFT JOIN (
          SELECT
            ar."answerId" AS id,
            SUM(IIF(ar.reaction = 'Heart', 1, 0)) AS heart_count,
            SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
            SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
            SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
            SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count
          FROM "AnswerReaction" ar
          GROUP BY ar."answerId"
        ) r ON q.id = r.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("answerId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "checkCount" = EXCLUDED."checkCount", "crossCount" = EXCLUDED."crossCount";
    `);
      await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Answer'`);
    };

    const updateTagMetrics = async () => {
      await dbWrite.$executeRawUnsafe(`
      -- Get all engagements that have happened since then that affect metrics
      WITH recent_engagements AS
      (
        SELECT
          "tagId" AS id
        FROM "Model" m
        JOIN "TagsOnModels" tom ON tom."modelId" = m.id
        WHERE (m."updatedAt" > '${lastUpdate}')

        UNION

        SELECT
          "tagId" AS id
        FROM "TagEngagement"
        WHERE ("createdAt" > '${lastUpdate}')

        UNION

        SELECT
          "tagId" AS id
        FROM "Image" i
        JOIN "TagsOnImage" toi ON toi."imageId" = i.id
        WHERE (i."createdAt" > '${lastUpdate}')
      ),
      -- Get all affected
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          WHERE r.id IS NOT NULL
      )

      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "TagMetric" ("tagId", timeframe, "followerCount", "hiddenCount", "modelCount", "imageCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN follower_count
          WHEN tf.timeframe = 'Year' THEN year_follower_count
          WHEN tf.timeframe = 'Month' THEN month_follower_count
          WHEN tf.timeframe = 'Week' THEN week_follower_count
          WHEN tf.timeframe = 'Day' THEN day_follower_count
        END AS follower_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN hidden_count
          WHEN tf.timeframe = 'Year' THEN year_hidden_count
          WHEN tf.timeframe = 'Month' THEN month_hidden_count
          WHEN tf.timeframe = 'Week' THEN week_hidden_count
          WHEN tf.timeframe = 'Day' THEN day_hidden_count
        END AS hidden_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN model_count
          WHEN tf.timeframe = 'Year' THEN year_model_count
          WHEN tf.timeframe = 'Month' THEN month_model_count
          WHEN tf.timeframe = 'Week' THEN week_model_count
          WHEN tf.timeframe = 'Day' THEN day_model_count
        END AS model_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN image_count
          WHEN tf.timeframe = 'Year' THEN year_image_count
          WHEN tf.timeframe = 'Month' THEN month_image_count
          WHEN tf.timeframe = 'Week' THEN week_image_count
          WHEN tf.timeframe = 'Day' THEN day_image_count
        END AS image_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(ft.follower_count, 0) AS follower_count,
          COALESCE(ft.year_follower_count, 0) AS year_follower_count,
          COALESCE(ft.month_follower_count, 0) AS month_follower_count,
          COALESCE(ft.week_follower_count, 0) AS week_follower_count,
          COALESCE(ft.day_follower_count, 0) AS day_follower_count,
          COALESCE(ft.hidden_count, 0) AS hidden_count,
          COALESCE(ft.year_hidden_count, 0) AS year_hidden_count,
          COALESCE(ft.month_hidden_count, 0) AS month_hidden_count,
          COALESCE(ft.week_hidden_count, 0) AS week_hidden_count,
          COALESCE(ft.day_hidden_count, 0) AS day_hidden_count,
          COALESCE(r.model_count, 0) AS model_count,
          COALESCE(r.year_model_count, 0) AS year_model_count,
          COALESCE(r.month_model_count, 0) AS month_model_count,
          COALESCE(r.week_model_count, 0) AS week_model_count,
          COALESCE(r.day_model_count, 0) AS day_model_count,
          COALESCE(i.image_count, 0) AS image_count,
          COALESCE(i.year_image_count, 0) AS year_image_count,
          COALESCE(i.month_image_count, 0) AS month_image_count,
          COALESCE(i.week_image_count, 0) AS week_image_count,
          COALESCE(i.day_image_count, 0) AS day_image_count
        FROM affected a
        LEFT JOIN (
          SELECT
            "tagId" id,
            COUNT("modelId") model_count,
            SUM(IIF(m."publishedAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_model_count,
            SUM(IIF(m."publishedAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_model_count,
            SUM(IIF(m."publishedAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_model_count,
            SUM(IIF(m."publishedAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_model_count
          FROM "TagsOnModels" tom
          JOIN "Model" m ON m.id = tom."modelId"
          GROUP BY "tagId"
        ) r ON r.id = a.id
        LEFT JOIN (
          SELECT
            "tagId" id,
            COUNT("imageId") image_count,
            SUM(IIF(i."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_image_count,
            SUM(IIF(i."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_image_count,
            SUM(IIF(i."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_image_count,
            SUM(IIF(i."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_image_count
          FROM "TagsOnImage" toi
          JOIN "Image" i ON i.id = toi."imageId"
          GROUP BY "tagId"
        ) i ON i.id = a.id
        LEFT JOIN (
          SELECT
            "tagId"                                                                      AS id,
            SUM(IIF(type = 'Follow', 1, 0))                                                     AS follower_count,
            SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_follower_count,
            SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0))  AS month_follower_count,
            SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0))   AS week_follower_count,
            SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0))   AS day_follower_count,
            SUM(IIF(type = 'Hide', 1, 0))                                                       AS hidden_count,
            SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0))   AS year_hidden_count,
            SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0))    AS month_hidden_count,
            SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0))     AS week_hidden_count,
            SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0))     AS day_hidden_count
          FROM "TagEngagement"
          GROUP BY "tagId"
        ) ft ON a.id = ft.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("tagId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "modelCount" = EXCLUDED."modelCount", "hiddenCount" = EXCLUDED."hiddenCount";
    `);
      await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Tag'`);
    };

    const updateImageMetrics = async () => {
      await dbWrite.$executeRawUnsafe(`
      WITH recent_engagements AS
      (
        SELECT
          "imageId" AS id
        FROM "ImageReaction"
        WHERE "createdAt" > '${lastUpdate}'

        UNION

        SELECT t."imageId" as id
        FROM "Thread" t
        JOIN "CommentV2" c ON c."threadId" = t.id
        WHERE t."imageId" IS NOT NULL AND c."createdAt" > '${lastUpdate}'

        UNION

        SELECT
          "id"
        FROM "MetricUpdateQueue"
        WHERE type = 'Image'
      ),
      -- Get all affected users
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          WHERE r.id IS NOT NULL
      )

      -- upsert metrics for all affected users
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "ImageMetric" ("imageId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount", "commentCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN like_count
          WHEN tf.timeframe = 'Year' THEN year_like_count
          WHEN tf.timeframe = 'Month' THEN month_like_count
          WHEN tf.timeframe = 'Week' THEN week_like_count
          WHEN tf.timeframe = 'Day' THEN day_like_count
        END AS like_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN dislike_count
          WHEN tf.timeframe = 'Year' THEN year_dislike_count
          WHEN tf.timeframe = 'Month' THEN month_dislike_count
          WHEN tf.timeframe = 'Week' THEN week_dislike_count
          WHEN tf.timeframe = 'Day' THEN day_dislike_count
        END AS dislike_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN heart_count
          WHEN tf.timeframe = 'Year' THEN year_heart_count
          WHEN tf.timeframe = 'Month' THEN month_heart_count
          WHEN tf.timeframe = 'Week' THEN week_heart_count
          WHEN tf.timeframe = 'Day' THEN day_heart_count
        END AS heart_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN laugh_count
          WHEN tf.timeframe = 'Year' THEN year_laugh_count
          WHEN tf.timeframe = 'Month' THEN month_laugh_count
          WHEN tf.timeframe = 'Week' THEN week_laugh_count
          WHEN tf.timeframe = 'Day' THEN day_laugh_count
        END AS laugh_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN cry_count
          WHEN tf.timeframe = 'Year' THEN year_cry_count
          WHEN tf.timeframe = 'Month' THEN month_cry_count
          WHEN tf.timeframe = 'Week' THEN week_cry_count
          WHEN tf.timeframe = 'Day' THEN day_cry_count
        END AS cry_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN comment_count
          WHEN tf.timeframe = 'Year' THEN year_comment_count
          WHEN tf.timeframe = 'Month' THEN month_comment_count
          WHEN tf.timeframe = 'Week' THEN week_comment_count
          WHEN tf.timeframe = 'Day' THEN day_comment_count
        END AS comment_count
      FROM
      (
        SELECT
          q.id,
          COALESCE(r.heart_count, 0) AS heart_count,
          COALESCE(r.year_heart_count, 0) AS year_heart_count,
          COALESCE(r.month_heart_count, 0) AS month_heart_count,
          COALESCE(r.week_heart_count, 0) AS week_heart_count,
          COALESCE(r.day_heart_count, 0) AS day_heart_count,
          COALESCE(r.laugh_count, 0) AS laugh_count,
          COALESCE(r.year_laugh_count, 0) AS year_laugh_count,
          COALESCE(r.month_laugh_count, 0) AS month_laugh_count,
          COALESCE(r.week_laugh_count, 0) AS week_laugh_count,
          COALESCE(r.day_laugh_count, 0) AS day_laugh_count,
          COALESCE(r.cry_count, 0) AS cry_count,
          COALESCE(r.year_cry_count, 0) AS year_cry_count,
          COALESCE(r.month_cry_count, 0) AS month_cry_count,
          COALESCE(r.week_cry_count, 0) AS week_cry_count,
          COALESCE(r.day_cry_count, 0) AS day_cry_count,
          COALESCE(r.dislike_count, 0) AS dislike_count,
          COALESCE(r.year_dislike_count, 0) AS year_dislike_count,
          COALESCE(r.month_dislike_count, 0) AS month_dislike_count,
          COALESCE(r.week_dislike_count, 0) AS week_dislike_count,
          COALESCE(r.day_dislike_count, 0) AS day_dislike_count,
          COALESCE(r.like_count, 0) AS like_count,
          COALESCE(r.year_like_count, 0) AS year_like_count,
          COALESCE(r.month_like_count, 0) AS month_like_count,
          COALESCE(r.week_like_count, 0) AS week_like_count,
          COALESCE(r.day_like_count, 0) AS day_like_count,
          COALESCE(c.comment_count, 0) AS comment_count,
          COALESCE(c.year_comment_count, 0) AS year_comment_count,
          COALESCE(c.month_comment_count, 0) AS month_comment_count,
          COALESCE(c.week_comment_count, 0) AS week_comment_count,
          COALESCE(c.day_comment_count, 0) AS day_comment_count
        FROM affected q
        LEFT JOIN (
          SELECT
            ic."imageId" AS id,
            COUNT(*) AS comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
            SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
          FROM "Thread" ic
          JOIN "CommentV2" v ON ic."id" = v."threadId"
          WHERE ic."imageId" IS NOT NULL
          GROUP BY ic."imageId"
        ) c ON q.id = c.id
        LEFT JOIN (
          SELECT
            ir."imageId" AS id,
            SUM(IIF(ir.reaction = 'Heart', 1, 0)) AS heart_count,
            SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
            SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
            SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
            SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count,
            SUM(IIF(ir.reaction = 'Like', 1, 0)) AS like_count,
            SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_like_count,
            SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_like_count,
            SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_like_count,
            SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_like_count,
            SUM(IIF(ir.reaction = 'Dislike', 1, 0)) AS dislike_count,
            SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_dislike_count,
            SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_dislike_count,
            SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_dislike_count,
            SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_dislike_count,
            SUM(IIF(ir.reaction = 'Cry', 1, 0)) AS cry_count,
            SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cry_count,
            SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cry_count,
            SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cry_count,
            SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cry_count,
            SUM(IIF(ir.reaction = 'Laugh', 1, 0)) AS laugh_count,
            SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_laugh_count,
            SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_laugh_count,
            SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_laugh_count,
            SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_laugh_count
          FROM "ImageReaction" ir
          GROUP BY ir."imageId"
        ) r ON q.id = r.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("imageId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount";
    `);

      await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Image'`);
    };

    const refreshModelRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "ModelRank"');

    const refreshVersionModelRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "ModelVersionRank"');

    const refreshTagRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "TagRank"');

    const refreshUserRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "UserRank"');

    const refreshImageRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "ImageRank"');

    const clearDayMetrics = async () =>
      await Promise.all(
        [
          `UPDATE "ModelMetric" SET "downloadCount" = 0, "ratingCount" = 0, rating = 0, "favoriteCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
          `UPDATE "ModelVersionMetric" SET "downloadCount" = 0, "ratingCount" = 0, rating = 0, "favoriteCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
          `UPDATE "QuestionMetric" SET "answerCount" = 0, "commentCount" = 0, "heartCount" = 0 WHERE timeframe = 'Day';`,
          `UPDATE "AnswerMetric" SET "heartCount" = 0, "checkCount" = 0, "crossCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
          `UPDATE "ImageMetric" SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
        ].map((x) => dbWrite.$executeRawUnsafe(x))
      );

    // If this is the first metric update of the day, reset the day metrics
    // -------------------------------------------------------------------
    if (lastUpdateDate.getDate() !== new Date().getDate()) {
      await clearDayMetrics();
      log('Cleared day metrics');
    }

    // Update all affected metrics
    // --------------------------------------------
    await updateModelMetrics('models');
    await updateModelMetrics('versions');
    await updateAnswerMetrics();
    await updateQuestionMetrics();
    await updateUserMetrics();
    await updateTagMetrics();
    await updateImageMetrics();
    await refreshModelRank();
    await refreshVersionModelRank();
    await refreshTagRank();
    log('Updated metrics');

    // Update the last update time
    // --------------------------------------------
    await dbWrite?.keyValue.upsert({
      where: { key: METRIC_LAST_UPDATED_KEY },
      create: { key: METRIC_LAST_UPDATED_KEY, value: new Date().getTime() },
      update: { value: new Date().getTime() },
    });

    // Check if we need to update the slow ranks
    // --------------------------------------------
    const shouldUpdateRanks = lastRankDate.getTime() + RANK_UPDATE_DELAY <= new Date().getTime();
    if (shouldUpdateRanks) {
      await refreshImageRank();
      await refreshUserRank();
      log('Updated ranks');
      await dbWrite?.keyValue.upsert({
        where: { key: RANK_LAST_UPDATED_KEY },
        create: { key: RANK_LAST_UPDATED_KEY, value: new Date().getTime() },
        update: { value: new Date().getTime() },
      });
    }
  },
  {
    lockExpiration: 5 * 60,
  }
);

type MetricUpdateType = 'Model' | 'ModelVersion' | 'Answer' | 'Question' | 'User' | 'Tag' | 'Image';
export const queueMetricUpdate = async (type: MetricUpdateType, id: number) => {
  try {
    await dbWrite.metricUpdateQueue.createMany({ data: { type, id } });
  } catch (e) {
    // Ignore duplicate errors
  }
};
