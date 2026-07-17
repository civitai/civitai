import { beforeEach, describe, expect, it } from 'vitest';
import { deleteResourceReviewForUser } from './resource-review.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('resource-review per-table deletes', () => {
  it('deleteResourceReviewForUser: delete from table where userId', async () => {
    await deleteResourceReviewForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "ResourceReview" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });
});
