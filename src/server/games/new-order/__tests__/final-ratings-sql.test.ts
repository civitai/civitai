import { describe, it, expect } from 'vitest';

// The final-ratings settle runs inside ClickHouse, so these pin its vote-selection SQL by equality
// on the normalised fragment: a settled round must never be rewritten, and neither may a vote cast
// after the decision was queued.

import { NewOrderImageRatingStatus } from '~/server/common/enums';
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

  // Evaluates the settle's two CASE expressions for one vote against one decision, so the grading
  // rule is checked by its outcomes rather than its spelling.
  const evaluate = (decision: number | null, vote: number) => {
    const sql = norm(buildFinalRatingsInsert({ updateStart: new Date(0), updateEnd: new Date(1) }));
    const caseOf = (alias: string) => {
      const close = sql.indexOf(`END AS ${alias}`);
      const open = sql.lastIndexOf('CASE ', close);
      if (close < 0 || open < 0) throw new Error(`no CASE for ${alias}`);
      return sql.slice(open + 'CASE '.length, close).trim();
    };
    const run = (expr: string) => {
      for (const branch of expr.split(/ (?=WHEN |ELSE )/)) {
        const when = branch.match(/^WHEN (.+?) THEN (.+)$/);
        const value = (when ? when[2] : branch.replace(/^ELSE /, '')).replace(/^'|'$/g, '');
        if (!when) return value;
        const cond = when[1];
        if (cond === 'new.rating IS NULL' && decision === null) return value;
        if (cond === 'new.rating = orig.rating' && decision !== null && decision === vote)
          return value;
        if (cond !== 'new.rating IS NULL' && cond !== 'new.rating = orig.rating')
          throw new Error(`unknown condition ${cond}`);
      }
      throw new Error('no branch matched');
    };
    return { status: run(caseOf('status')), multiplier: Number(run(caseOf('multiplier'))) };
  };

  it('grades a vote by the decision: none is Inconclusive, a match Correct, anything else Failed', () => {
    expect(evaluate(null, 4)).toEqual({
      status: NewOrderImageRatingStatus.Inconclusive,
      multiplier: 0,
    });
    expect(evaluate(4, 4)).toEqual({ status: NewOrderImageRatingStatus.Correct, multiplier: 1 });
    expect(evaluate(8, 4)).toEqual({ status: NewOrderImageRatingStatus.Failed, multiplier: 0 });
  });

  it('the batch window runs from the start (exclusive) to the end (inclusive), in that order', () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    const end = new Date('2026-11-02T00:00:00.000Z');
    const sql = norm(buildFinalRatingsInsert({ updateStart: start, updateEnd: end }));

    const lower = sql.indexOf(`update_time > parseDateTimeBestEffort('${start.toISOString()}')`);
    const upper = sql.indexOf(`update_time <= parseDateTimeBestEffort('${end.toISOString()}')`);
    expect(lower).toBeGreaterThan(-1);
    expect(upper).toBeGreaterThan(lower);
  });
});
