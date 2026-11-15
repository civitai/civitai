// A leaf with no imports, so a module that only needs this string (redis/caches.ts) does not load
// the review-visibility service and, through it, the notification service.

/** The SQL twin of `visibleReviewWhere`, without the author exception. A plain string, for the metric jobs. */
export const visibleReviewSql = (alias: string) =>
  `(${alias}."postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" rvp WHERE rvp.id = ${alias}."postId" AND rvp."publishedAt" <= now()))`;
