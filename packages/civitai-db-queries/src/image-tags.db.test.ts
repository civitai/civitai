import { beforeEach, describe, expect, it } from 'vitest';
import {
  getImageTagReviewImages,
  getImageTagReviewTags,
  getImageTagReviewQueue,
  getImageTagsNeedingReview,
} from './image-tags.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getImageTagReviewImages', () => {
  it('emits the exact bitmask predicates, nsfwLevel guard, and limit param (no cursor)', async () => {
    await getImageTagReviewImages(harness.db, { limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    // The bitmask predicates must match the partial indexes EXACTLY (bit 9 = needsReview, bit 10 = disabled).
    expect(sql).toContain('(((attributes >> 9)::integer & 1) = 1)');
    expect(sql).toContain('(((attributes >> 10)::integer & 1) <> 1)');
    expect(sql).toContain('WITH reviewable AS MATERIALIZED');
    expect(sql).toContain('ORDER BY i.id DESC');
    // no cursor fragment when cursor is absent
    expect(sql).not.toContain('AND "imageId" <');

    // params: NsfwLevel.Blocked (32), then limit + 1 (21)
    expect(parameters).toEqual([32, 21]);
  });

  it('adds the cursor predicate + param when a cursor is given', async () => {
    await getImageTagReviewImages(harness.db, { cursor: 9000, limit: 10 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('AND "imageId" <');
    // param order follows SQL position: cursor(9000), Blocked(32), limit+1(11)
    expect(parameters).toEqual([9000, 32, 11]);
  });
});

describe('getImageTagReviewTags', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getImageTagReviewTags(harness.db, []);

    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('emits the vote aggregation, Moderation-type join, and both IN lists as bound params', async () => {
    await getImageTagReviewTags(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain(`JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'`);
    // vote aggregation over TagsOnImageVote
    expect(sql).toContain('SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) up');
    expect(sql).toContain('SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) down');
    expect(sql).toContain('AND d.disabled = false');
    expect(sql).toContain('ORDER BY d."imageId", "downVotes" DESC');
    expect(sql).not.toContain('in ()');
    expect(sql).not.toContain('IN ()');
    // ids appear twice (vote subquery WHERE + outer WHERE) → six bound params
    expect(parameters).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe('getImageTagReviewQueue', () => {
  it('runs the images query then (with no rows under the dummy driver) skips the tags query', async () => {
    const result = await getImageTagReviewQueue(harness.db, { limit: 20 });

    // DummyDriver returns no rows → ids empty → tags query is guarded away.
    expect(harness.queries).toHaveLength(1);
    expect(harness.lastQuery().sql).toContain('WITH reviewable AS MATERIALIZED');
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe('getImageTagsNeedingReview', () => {
  it('resolves an image’s flagged Moderation tags by imageId + needsReview', async () => {
    await getImageTagsNeedingReview(harness.db, { imageId: 42 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('SELECT d."tagId"');
    expect(sql).toContain(`JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'`);
    expect(sql).toContain('d."imageId" =');
    expect(sql).toContain('d."needsReview" = true');
    expect(parameters).toEqual([42]);
  });
});
