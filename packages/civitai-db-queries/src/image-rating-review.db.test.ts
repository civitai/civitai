import { beforeEach, describe, expect, it } from 'vitest';
import { getImageRatingRequests, getImageRatingReviewCount } from './image-rating-review.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getImageRatingRequests', () => {
  it('emits the raw jsonb vote tally, enum cast, predicate, and limit param (no cursor)', async () => {
    await getImageRatingRequests(harness.db, { limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    // jsonb_build_object vote tally with SUM ... FILTER per nsfwLevel bit
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain('COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 1), 0)');
    expect(sql).toContain('COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 16), 0)');
    // total-weight threshold predicate
    expect(sql).toContain('WHERE irr.total >= 3');
    // enum cast for ingestion status
    expect(sql).toContain(`i.ingestion != 'PendingManualAssignment'::"ImageIngestionStatus"`);
    // nsfwLevel < Blocked (32) and LIMIT are bound params
    expect(sql).toContain('i."nsfwLevel" <');
    expect(sql).toContain('ORDER BY i."id" ASC');
    // no cursor fragment when cursor is absent
    expect(sql).not.toContain('AND i."id" >=');

    // params: NsfwLevel.Blocked (32), then limit + 1 (21)
    expect(parameters).toEqual([32, 21]);
  });

  it('adds the cursor predicate + param when a cursor is given', async () => {
    await getImageRatingRequests(harness.db, { cursor: 5000, limit: 10 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('AND i."id" >=');
    // param order follows SQL position: Blocked(32), cursor(5000), limit+1(11)
    expect(parameters).toEqual([32, 5000, 11]);
  });
});

describe('getImageRatingReviewCount', () => {
  it('emits the same predicate as a count, without paging', async () => {
    await getImageRatingReviewCount(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('SELECT count(*)::int count');
    expect(sql).toContain("WHERE status = 'Pending'");
    expect(sql).toContain('WHERE irr.total >= 3');
    expect(sql).toContain(`i.ingestion != 'PendingManualAssignment'::"ImageIngestionStatus"`);
    // no cursor / limit paging in the count query
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('AND i."id" >=');
    // only the Blocked(32) param remains
    expect(parameters).toEqual([32]);
  });
});
