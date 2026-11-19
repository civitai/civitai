/**
 * Unclassified articles the Story Writers board could score: the eligibility filters of its live query
 * (Leaderboard row 'story-writer', last changed by 20271116120000_story_writer_count_mature) minus the
 * category one. $1 = id to page after, $2 = limit, $3 = also select articles rated R and above, which
 * the board counts from that migration on, $4 = published and last edited before (the retry job's settle).
 * Keep in step with that query's WHERE, apart from $3 and $4.
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
  AND a."publishedAt" < $4 AND a."updatedAt" < $4
  AND a.ingestion = 'Scanned'
  AND NOT a."tosViolation"
  AND NOT a.unlisted
  AND a.availability <> 'Private'
  AND a."nsfwLevel" <> 0
  AND ($3::boolean OR (a."nsfwLevel" & ~3) = 0)
  AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL AND u.id > 0
ORDER BY a.id
LIMIT $2`;
