import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  invalidatedAfter: [] as number[],
  bustedPictures: [] as { imageIds: number[]; after: number }[],
}));

vi.mock('../db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(h.sql, [], h.params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => '[]' }) }));
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustImageTagCaches: vi.fn() }));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', () => ({
  invalidateThumbnails: vi.fn(async () => {
    h.invalidatedAfter.push(h.sql.length);
  }),
}));
vi.mock('../profile-picture-cache', () => ({
  bustProfilePictures: vi.fn(async (target: { imageIds: number[] }) => {
    h.bustedPictures.push({ imageIds: target.imageIds, after: h.sql.length });
  }),
}));

const { upsertTagsOnImageNew } = await import('../tags-on-image.service');
const { bustImageTagCaches } = await import('../cache');
const { logAxiomError } = await import('../axiom');

const flat = (i: number) => h.sql[i].replace(/\s+/g, ' ').trim();

beforeEach(() => {
  h.sql.length = 0;
  h.params.length = 0;
  h.invalidatedAfter.length = 0;
  h.bustedPictures.length = 0;
});

describe('upsertTagsOnImageNew', () => {
  it('queues an image a written blocked-level tag raised to Blocked for tag review', async () => {
    await upsertTagsOnImageNew([{ imageId: 1, tagId: 2 }]);

    expect(h.sql).toHaveLength(3);
    expect(flat(0)).toContain('upsert_tag_on_image');
    expect(flat(1)).toContain('update_nsfw_levels_new');

    const queue = flat(2);
    expect(queue).toContain('AND NOT toi.disabled');
    expect(queue).toContain(`UPDATE "Image" i SET "needsReview" = 'tag'`);
    expect(queue).toContain('AND i."needsReview" IS NULL');
    expect(queue).toContain(`AND i.ingestion = 'Scanned'`);
    expect(queue).toContain('AND i."blockedFor" IS NULL');
    expect(queue).toContain('AND NOT i."nsfwLevelLocked"');
    expect(queue).toContain('INSERT INTO "ImageTagForReview"');
    // Both level comparisons — the written tag's and the image's — bind Blocked.
    expect(h.params[2].filter((p) => p === 32)).toHaveLength(2);
  });

  it('invalidates thumbnails only after the level recompute has run', async () => {
    await upsertTagsOnImageNew([{ imageId: 1, tagId: 2 }]);

    // Two statements in: the upsert and update_nsfw_levels_new.
    expect(h.invalidatedAfter).toEqual([2]);
  });

  // The main app serves avatars from a day-long profile-picture cache and gates them on its rating, so
  // a tag that re-rates someone's avatar has to evict that entry too.
  it('evicts the cached profile pictures of the re-rated images after the recompute', async () => {
    await upsertTagsOnImageNew([
      { imageId: 31, tagId: 2 },
      { imageId: 32, tagId: 2 },
    ]);

    expect(h.bustedPictures).toEqual([{ imageIds: [31, 32], after: 2 }]);
  });

  // The tag rows and the level are committed by then: a Redis failure on the tag caches must neither
  // fail the write nor skip the thumbnail and avatar refreshes after it.
  it('completes, and still refreshes thumbnails and avatars, when the tag-cache bust fails', async () => {
    vi.mocked(logAxiomError).mockClear();
    vi.mocked(bustImageTagCaches).mockRejectedValueOnce(new Error('redis down'));

    await expect(upsertTagsOnImageNew([{ imageId: 31, tagId: 2 }])).resolves.toBeUndefined();

    expect(h.invalidatedAfter).toEqual([2]);
    expect(h.bustedPictures).toEqual([{ imageIds: [31], after: 2 }]);
    expect(logAxiomError).toHaveBeenCalledTimes(1);
  });
});
