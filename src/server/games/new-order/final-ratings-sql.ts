import { NewOrderImageRatingStatus } from '~/server/common/enums';

const chDate = (d: Date) => `parseDateTimeBestEffort('${d.toISOString()}')`;

/**
 * Votes a final-ratings batch settles: each Knight's latest vote on an image in the batch, kept
 * only while it is still Pending and was cast before the decision was queued. Rounds that already
 * settled, and votes of a round that started after the decision, are left alone.
 */
export const PENDING_VOTES_CTE = `
  pending AS (
    SELECT
      userId,
      imageId,
      argMax(rating, createdAt) AS rating,
      argMax(damnedReason, createdAt) AS damnedReason,
      argMax(grantedExp, createdAt) AS grantedExp,
      argMax(ip, createdAt) AS ip,
      argMax(userAgent, createdAt) AS userAgent,
      argMax(deviceId, createdAt) AS deviceId,
      argMax(rank, createdAt) AS rank,
      argMax(originalLevel, createdAt) AS originalLevel,
      argMax(status, createdAt) AS latestStatus,
      max(createdAt) AS latestCreatedAt
    FROM knights_new_order_image_rating
    WHERE imageId IN (SELECT imageId FROM batch)
    GROUP BY userId, imageId
    HAVING latestStatus = '${NewOrderImageRatingStatus.Pending}' AND rank != 'Acolyte'
  )`;

export const PENDING_VOTES_JOIN = `
  FROM pending orig
  JOIN batch new ON new.imageId = orig.imageId
  WHERE orig.latestCreatedAt <= new.createdAt`;

/** The INSERT that settles every pending vote in the decisions queued between the two times. */
export function buildFinalRatingsInsert({
  updateStart,
  updateEnd,
}: {
  updateStart: Date;
  updateEnd: Date;
}) {
  return `
    INSERT INTO knights_new_order_image_rating
    WITH batch AS (
      SELECT
        imageId,
        argMax(rating, update_time) AS rating,
        max(update_time) AS createdAt
      FROM knights_rating_updates_batch
      WHERE update_time > ${chDate(updateStart)} AND update_time <= ${chDate(updateEnd)}
      GROUP BY imageId
    ),${PENDING_VOTES_CTE}
    SELECT
      orig.userId,
      orig.imageId AS imageId,
      orig.rating AS rating,
      orig.damnedReason,
      CASE
        WHEN new.rating IS NULL THEN '${NewOrderImageRatingStatus.Inconclusive}'
        WHEN new.rating = orig.rating THEN '${NewOrderImageRatingStatus.Correct}'
        ELSE '${NewOrderImageRatingStatus.Failed}'
      END AS status,
      orig.grantedExp,
      CASE WHEN new.rating = orig.rating THEN 1 ELSE 0 END AS multiplier,
      new.createdAt AS createdAt,
      orig.ip,
      orig.userAgent,
      orig.deviceId,
      orig.rank,
      orig.originalLevel${PENDING_VOTES_JOIN};
  `;
}
