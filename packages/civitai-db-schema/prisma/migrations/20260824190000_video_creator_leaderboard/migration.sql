-- Video creator leaderboard, step 1 of 2 (ClickUp 868ktjte4).
-- Data rows, not schema. Apply by hand; this repo does not run prisma migrate deploy.
--
-- Staged as active = true, public = false: prepare-leaderboard only populates active boards,
-- and public = false keeps the board and its results moderator-only. Flip public to true once
-- the populated rows have been checked, and only then apply
-- 20260824190001_video_creator_leaderboard_badges.
--
-- Badges are deliberately NOT in this file. deliver-leaderboard-cosmetics selects every
-- Cosmetic with a leaderboardId and joins it to LeaderboardResult, with no check on
-- Leaderboard.public or .active, so a badge that exists when the board first populates is
-- awarded and equippable that same night, before anyone has read a row.
--
-- Do not apply between 23:00 and 00:01 UTC. isLeaderboardPopulated compares boards populated
-- for today against the count of active boards, and update-user-leaderboard-rank and
-- deliver-leaderboard-cosmetics both throw on it at 00:01 — so a row added after that night's
-- prepare-leaderboard run costs every board its rank rebuild and cosmetic delivery for one night.
--
-- The query is the images-overall board's query plus one filter, ic.mediaType = 'video'.
-- Keep the CTE named ch_image_scores. prepare-leaderboard dispatches on 'image_scores AS' to
-- the image path, then on 'ch_image_scores' inside it to choose ClickHouse over Postgres; a
-- rename that drops the prefix sends this query to node-postgres, which cannot parse
-- {from: Int32} or SETTINGS.

INSERT INTO "Leaderboard" (id, index, title, description, "scoringDescription", query, active, public)
SELECT 'videos-overall', 19, 'Master Generators (Video)',
       'Creators that have made the most popular safe-for-work (PG, PG-13) videos',
       E'√(reactions)\r\n---\r\nDiminishing returns up to 120 entries',
$q$WITH ch_image_scores AS (
  SELECT
      ic.id as "imageId",
      ic.userId as userId,
      max(1 - min2(1 * pow(age('day',now(),ic."createdAt")/30, 2), 1)) as ageMultiplier,
      sum(r.metricValue) as reactions,
      max2(reactions * ageMultiplier, 0) as score,
      toJSONString(map('reactionCount', max2(reactions, 0))) as "metrics"
    FROM (
      SELECT entityId, userId, createdAt, argMax(metricValue, version) AS metricValue
      FROM entityMetricEvents_month
      WHERE entityType = 'Image'
        AND entityId BETWEEN {from: Int32} AND {to: Int32}
        AND createdAt > NOW() - INTERVAL '30 days'
        AND metricType IN ('Like','Heart','Cry','Laugh','ReactionLike','ReactionHeart','ReactionCry','ReactionLaugh')
      GROUP BY entityType, entityId, metricType, userId, createdAt
    ) r
    JOIN images_created ic ON ic.id = r.entityId
    WHERE ic.id BETWEEN {from: Int32} AND {to: Int32}
      AND ic.mediaType = 'video'
      AND ic.nsfwLevel IN ('PG', 'PG13')
    GROUP BY 1, 2
)
SELECT * FROM ch_image_scores ORDER BY score DESC
SETTINGS max_memory_usage = 5000000000;$q$,
       true, false
WHERE NOT EXISTS (SELECT 1 FROM "Leaderboard" WHERE id = 'videos-overall');
