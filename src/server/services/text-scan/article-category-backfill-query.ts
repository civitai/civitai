/**
 * Unclassified articles the Story Writers board could score: its eligibility filters (migration
 * 20261112170000_story_writer_leaderboard) minus the category one. $1 = id to page after, $2 = limit.
 * Keep in step with that query's WHERE.
 */
export const ARTICLE_CATEGORY_BACKFILL_SQL = `
SELECT a.id
FROM "Article" a
JOIN "User" u ON u.id = a."userId"
WHERE
  a."systemCategoryId" IS NULL
  AND a.id > $1
  AND a.status = 'Published'
  AND a."publishedAt" BETWEEN current_date - INTERVAL '30 days' AND now()
  AND a.ingestion = 'Scanned'
  AND NOT a."tosViolation"
  AND NOT a.unlisted
  AND a.availability <> 'Private'
  AND a."nsfwLevel" <> 0 AND (a."nsfwLevel" & ~3) = 0
  AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
ORDER BY a.id
LIMIT $2`;
