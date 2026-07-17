import { beforeEach, describe, expect, it } from 'vitest';
import {
  createImageTagsForReview,
  deleteImagTagsForReviewByImageIds,
  disableTags,
  getImagTagsForReviewByImageIds,
  getImageTagReviewImages,
  getImageTagReviewTags,
  getImageTagReviewQueue,
  getImageTagsNeedingReview,
  getTagsForReview,
  moderateTags,
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

describe('getTagsForReview', () => {
  it('emits the DISTINCT ON tags query + count query, scoped to Image.needsReview', async () => {
    await getTagsForReview(harness.db, { reviewType: 'minor', take: 20, skip: 40 });

    expect(harness.queries).toHaveLength(2);
    const [items, counts] = harness.queries;

    expect(items.sql).toContain('SELECT DISTINCT ON (t.name) t.id, t.name');
    expect(items.sql).toContain('FROM "ImageTagForReview" it');
    expect(items.sql).toContain('WHERE i."needsReview" =');
    expect(items.sql).toContain('ORDER BY t.name');
    expect(items.parameters).toEqual(['minor', 20, 40]);

    expect(counts.sql).toContain('SELECT COUNT(DISTINCT t.id)::int AS count');
    expect(counts.parameters).toEqual(['minor']);
  });
});

describe('moderateTags', () => {
  it('throws Not implemented for model (unimplemented in the source)', async () => {
    await expect(
      moderateTags(harness.db, { entityIds: [1], entityType: 'model', disable: true })
    ).rejects.toThrow('Not implemented');
  });

  it('image: selects needsReview pairs (upsert skipped as no rows under dummy driver)', async () => {
    await moderateTags(harness.db, { entityIds: [1, 2], entityType: 'image', disable: true });

    // DummyDriver returns no rows → upsertTagsOnImageNew([]) is guarded away → only the SELECT runs.
    expect(harness.queries).toHaveLength(1);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('FROM "TagsOnImageDetails"');
    expect(sql).toContain('"needsReview" = true');
    expect(sql).toContain('"imageId" IN ($1, $2)');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toEqual([1, 2]);
  });

  it('image with empty entityIds: no query', async () => {
    await moderateTags(harness.db, { entityIds: [], entityType: 'image', disable: true });
    expect(harness.queries).toHaveLength(0);
  });
});

describe('disableTags', () => {
  it('model + tag ids: UPDATE TagsOnModels with ANY(::int[]) match', async () => {
    await disableTags(harness.db, { tags: [10, 20], entityIds: [1, 2], entityType: 'model' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain('UPDATE "TagsOnModels"');
    expect(sql).toContain('SET "disabled" = true');
    expect(sql).toContain('"modelId" = ANY(');
    expect(sql).toContain('"tagId" = ANY(');
  });

  it('image + tag names: SELECT pairs with name-subquery match (upsert skipped, no rows)', async () => {
    await disableTags(harness.db, {
      tags: ['nudity', 'gore'],
      entityIds: [1, 2],
      entityType: 'image',
    });
    expect(harness.queries).toHaveLength(1);
    const { sql } = harness.lastQuery();
    expect(sql).toContain('FROM "TagsOnImageDetails"');
    expect(sql).toContain('"imageId" = ANY(');
    expect(sql).toContain('"tagId" IN (SELECT id FROM "Tag" WHERE "name" = ANY(');
  });

  it('tag + tag ids: DELETE TagsOnTags with fromTagId match', async () => {
    await disableTags(harness.db, { tags: [10], entityIds: [1], entityType: 'tag' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain('DELETE FROM "TagsOnTags"');
    expect(sql).toContain('"toTagId" = ANY(');
    expect(sql).toContain('"fromTagId" = ANY(');
  });
});

describe('ImageTagForReview bulk rows', () => {
  it('createImageTagsForReview short-circuits an empty tag list', async () => {
    const result = await createImageTagsForReview(harness.db, { imageId: 42, tagIds: [] });
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('createImageTagsForReview inserts (imageId, tagId) rows ON CONFLICT DO NOTHING', async () => {
    await createImageTagsForReview(harness.db, { imageId: 42, tagIds: [10, 20] });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'insert into "ImageTagForReview" ("imageId", "tagId") ' +
        'values ($1, $2), ($3, $4) on conflict do nothing'
    );
    expect(parameters).toEqual([42, 10, 42, 20]);
  });

  it('deleteImagTagsForReviewByImageIds short-circuits an empty id list (no IN ())', async () => {
    const result = await deleteImagTagsForReviewByImageIds(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('deleteImagTagsForReviewByImageIds deletes by imageId IN list', async () => {
    await deleteImagTagsForReviewByImageIds(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "ImageTagForReview" where "imageId" in ($1, $2, $3)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });

  it('getImagTagsForReviewByImageIds short-circuits an empty id list (no IN ())', async () => {
    const result = await getImagTagsForReviewByImageIds(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('getImagTagsForReviewByImageIds reads (imageId, tagId) for the given images', async () => {
    await getImagTagsForReviewByImageIds(harness.db, [1, 2]);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "imageId", "tagId" from "ImageTagForReview" where "imageId" in ($1, $2)'
    );
    expect(parameters).toEqual([1, 2]);
  });
});
