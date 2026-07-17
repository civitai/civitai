import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteImagesByIds,
  deletePost,
  deletePostForUser,
  deletePostRecord,
  getPostImagesForDelete,
  unpublishPostsForUser,
  updatePostNsfwLevel,
  updatePostNsfwLevels,
} from './post.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('getPostImagesForDelete', () => {
  it('scopes to the owner when not a moderator', async () => {
    await getPostImagesForDelete(h.db, { postId: 5, isModerator: false });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('from "Image" as "i"');
    expect(sql).toContain('inner join "Post" as "p" on "p"."id" = "i"."postId"');
    expect(sql).toContain('"i"."postId" = $1');
    expect(sql).toContain('"i"."userId" = "p"."userId"');
    expect(parameters).toEqual([5]);
  });

  it('omits the owner filter for a moderator', async () => {
    await getPostImagesForDelete(h.db, { postId: 5, isModerator: true });
    const { sql } = h.lastQuery();
    expect(sql).not.toContain('"i"."userId" = "p"."userId"');
  });
});

describe('deleteImagesByIds', () => {
  it('short-circuits an empty id list without a query', async () => {
    const result = await deleteImagesByIds(h.db, []);
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('deletes the given images returning id + url', async () => {
    await deleteImagesByIds(h.db, [1, 2]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Image" where "id" in ($1, $2) returning "id", "url"');
    expect(parameters).toEqual([1, 2]);
  });
});

describe('deletePostRecord', () => {
  it('deletes the post returning id + nsfwLevel', async () => {
    await deletePostRecord(h.db, 5);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Post" where "id" = $1 returning "id", "nsfwLevel"');
    expect(parameters).toEqual([5]);
  });
});

describe('deletePost', () => {
  it('composes the image lookup + post delete in one transaction', async () => {
    const result = await deletePost(h.db, { id: 5, isModerator: true });
    // DummyDriver returns no images, so the image DELETE is skipped; the post DELETE still runs.
    expect(result.deletedImages).toEqual([]);
    const imageLookup = h.queries[0];
    const postDelete = h.queries[h.queries.length - 1];
    expect(imageLookup.sql).toContain('from "Image" as "i"');
    expect(postDelete.sql).toBe('delete from "Post" where "id" = $1 returning "id", "nsfwLevel"');
  });
});

describe('updatePostNsfwLevels', () => {
  it('short-circuits an empty id list without a query', async () => {
    await updatePostNsfwLevels(h.db, []);
    expect(h.queries).toHaveLength(0);
  });

  it('recomputes post nsfwLevel via bit_or of images, writing only changes', async () => {
    await updatePostNsfwLevels(h.db, [1, 2]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('bit_or(i."nsfwLevel")');
    expect(sql).toContain('UPDATE "Post" p');
    expect(sql).toContain('level."nsfwLevel" != p."nsfwLevel"');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toEqual([1, 2]);
  });
});

describe('updatePostNsfwLevel', () => {
  it('short-circuits an empty id list without a query', async () => {
    await updatePostNsfwLevel(h.db, []);
    expect(h.queries).toHaveLength(0);
  });

  it('dedupes ids and calls the update_post_nsfw_levels procedure', async () => {
    await updatePostNsfwLevel(h.db, [3, 3, 4]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('update_post_nsfw_levels(ARRAY[$1, $2]');
    expect(parameters).toEqual([3, 4]); // deduped
  });

  it('accepts a lone id', async () => {
    await updatePostNsfwLevel(h.db, 7);
    const { parameters } = h.lastQuery();
    expect(parameters).toEqual([7]);
  });
});

describe('per-user post content deletes', () => {
  it('unpublishPostsForUser stamps metadata, clears publishedAt, guards empty ids', async () => {
    const empty = await unpublishPostsForUser(h.db, {
      userId: 7,
      versionIds: [],
      unpublishedAt: 'now',
      unpublishedBy: 1,
    });
    expect(empty).toEqual([]);
    expect(h.queries).toHaveLength(0);

    await unpublishPostsForUser(h.db, {
      userId: 7,
      versionIds: [3, 4],
      unpublishedAt: '2026-01-01',
      unpublishedBy: 1,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('update "Post"');
    expect(sql).toContain('"publishedAt" = $');
    expect(sql).toContain('"publishedAt" is not null');
    expect(sql).toContain('"modelVersionId" in ($');
  });

  it('deletePostForUser deletes the user posts', async () => {
    await deletePostForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Post" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });
});
