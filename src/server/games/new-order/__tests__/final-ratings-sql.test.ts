import { describe, it, expect } from 'vitest';

// The final-ratings settle runs inside ClickHouse, so these pin its vote-selection SQL by equality
// on the normalised fragment: a settled round must never be rewritten, and neither may a vote cast
// after the decision was queued.

import {
  buildFinalRatingsInsert,
  PENDING_VOTES_CTE,
  PENDING_VOTES_JOIN,
} from '~/server/games/new-order/final-ratings-sql';

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('final-ratings settle SQL', () => {
  it('selects each voter’s latest vote, only while it is still Pending and not an Acolyte vote', () => {
    expect(norm(PENDING_VOTES_CTE)).toBe(
      norm(`
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
          HAVING latestStatus = 'Pending' AND rank != 'Acolyte'
        )`)
    );
  });

  it('settles only votes cast before the decision', () => {
    expect(norm(PENDING_VOTES_JOIN)).toBe(
      norm(`
        FROM pending orig
        JOIN batch new ON new.imageId = orig.imageId
        WHERE orig.latestCreatedAt <= new.createdAt`)
    );
  });

  it('the INSERT reads its votes from those fragments and the batch window it is given', () => {
    const sql = norm(
      buildFinalRatingsInsert({
        updateStart: new Date('2026-11-01T00:00:00.000Z'),
        updateEnd: new Date('2026-11-02T00:00:00.000Z'),
      })
    );

    expect(sql.startsWith('INSERT INTO knights_new_order_image_rating WITH batch AS (')).toBe(true);
    expect(sql).toContain(
      "WHERE update_time > parseDateTimeBestEffort('2026-11-01T00:00:00.000Z') AND update_time <= parseDateTimeBestEffort('2026-11-02T00:00:00.000Z')"
    );
    expect(sql).toContain(`), ${norm(PENDING_VOTES_CTE)} SELECT orig.userId,`);
    expect(sql.endsWith(`orig.originalLevel ${norm(PENDING_VOTES_JOIN)};`)).toBe(true);
    // The only vote source is the pending CTE: the raw table is read nowhere else.
    expect(sql.split('FROM knights_new_order_image_rating').length).toBe(2);
  });
});
