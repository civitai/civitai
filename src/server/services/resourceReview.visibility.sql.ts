// A leaf with no imports, so the caches and metric jobs that only need this string do not load the
// review-visibility service (and, through it, the notification service).

/** The SQL twin of `visibleReviewWhere`, without the author exception. A plain string, for the metric jobs. */
export const visibleReviewSql = (alias: string) =>
  `(${alias}."postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" rvp WHERE rvp.id = ${alias}."postId" AND rvp."publishedAt" <= now()))`;
