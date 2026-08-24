import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getImagesByEntity` and `getEntityCoverImage` used to associate tags to images
 * with `tagsVar?.filter((x) => x.imageId === i.id)` — a full scan of the tag
 * array once per image. `getImageTagsForImages` fetches the tags for EVERY image
 * in the batch, so the tag array grows with the image count and the join is
 * quadratic. `attachTagsToImages` indexes once and looks up.
 *
 * The behaviour that has to survive the rewrite:
 *   - each image gets exactly its OWN tags (ids, not positions);
 *   - an image with no tags gets `[]`, which is what `.filter()` returned, NOT
 *     the `undefined` a bare `Map.get()` hands back.
 *
 * Fixture discipline: every `imageId` here is deliberately distinct from its
 * index in both the image array and the tag array, so an off-by-one or an
 * index-vs-id mix-up cannot pass by coincidence.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
}));

// Only `imageTagsCache.fetch` is replaced; every other export of the caches
// module is carried through, so nothing else in image.service's import graph
// silently loses a binding.
const { imageTagsFetch } = vi.hoisted(() => ({ imageTagsFetch: vi.fn() }));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imageTagsCache: { fetch: imageTagsFetch, bust: vi.fn() },
}));

import {
  attachTagsToImages,
  getImagesByEntity,
  getEntityCoverImage,
} from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// ---------------------------------------------------------------------------
// The association step itself
// ---------------------------------------------------------------------------

describe('attachTagsToImages', () => {
  it('gives every image exactly its own tags, from an interleaved tag array', () => {
    // Ids are pairwise distinct from the array indices (0,1,2) on BOTH arrays,
    // and the tags arrive out of order and interleaved between images.
    const images = [{ id: 70 }, { id: 41 }, { id: 93 }];
    const tags = [
      { imageId: 93, name: 'c1' },
      { imageId: 70, name: 'a1' },
      { imageId: 41, name: 'b1' },
      { imageId: 70, name: 'a2' },
      { imageId: 93, name: 'c2' },
      { imageId: 41, name: 'b2' },
      { imageId: 70, name: 'a3' },
    ];

    const result = attachTagsToImages(images, tags);

    expect(result).toEqual([
      {
        id: 70,
        tags: [
          { imageId: 70, name: 'a1' },
          { imageId: 70, name: 'a2' },
          { imageId: 70, name: 'a3' },
        ],
      },
      {
        id: 41,
        tags: [
          { imageId: 41, name: 'b1' },
          { imageId: 41, name: 'b2' },
        ],
      },
      {
        id: 93,
        tags: [
          { imageId: 93, name: 'c1' },
          { imageId: 93, name: 'c2' },
        ],
      },
    ]);
  });

  it('preserves the relative order of an image’s own tags', () => {
    // `.filter()` kept source order; a grouping pass must too, because the tag
    // array arrives sorted by score and the client renders it as given.
    const result = attachTagsToImages(
      [{ id: 8 }],
      [
        { imageId: 8, name: 'first' },
        { imageId: 5, name: 'other' },
        { imageId: 8, name: 'second' },
        { imageId: 8, name: 'third' },
      ]
    );

    expect(result[0].tags.map((t) => t.name)).toEqual(['first', 'second', 'third']);
  });

  it('returns [] — not undefined — for an image with no tags', () => {
    // 🔴 THE regression test. `tagsByImageId?.get(i.id)` without `?? []` yields
    // `undefined` here, which is a different value on the wire from the `[]`
    // that `.filter()` produced. Images with no tags are common.
    const result = attachTagsToImages([{ id: 12 }], [{ imageId: 99, name: 'not-mine' }]);

    expect(result[0].tags, 'an image with no tags must receive [], not undefined').toEqual([]);
    expect(result[0].tags, 'an image with no tags must receive [], not undefined').not.toBe(
      undefined
    );
  });

  it('mixes tagged and untagged images in the same call', () => {
    const result = attachTagsToImages(
      [{ id: 31 }, { id: 64 }, { id: 22 }],
      [
        { imageId: 22, name: 'z' },
        { imageId: 31, name: 'x' },
      ]
    );

    expect(result[0].tags).toEqual([{ imageId: 31, name: 'x' }]);
    expect(result[1].tags, 'the middle image has no tags and must get []').toEqual([]);
    expect(result[2].tags).toEqual([{ imageId: 22, name: 'z' }]);
  });

  it('returns [] for every image when no tags were fetched at all', () => {
    // The `include` flag not asking for tags leaves `tagsVar` as `[]`; the
    // `undefined` arm is the defensive one. Both must land on `[]`, which is
    // what both call sites shipped before.
    for (const tags of [[] as { imageId: number }[], undefined]) {
      const result = attachTagsToImages([{ id: 3 }, { id: 77 }], tags);
      expect(result.map((r) => r.tags)).toEqual([[], []]);
    }
  });

  it('carries the image’s other fields through untouched', () => {
    const result = attachTagsToImages([{ id: 5, url: 'u', nsfwLevel: 1 }], [{ imageId: 5, x: 1 }]);

    expect(result[0]).toMatchObject({ id: 5, url: 'u', nsfwLevel: 1 });
  });

  it('does not mutate the tag array it was handed', () => {
    const tags = [{ imageId: 2, name: 'a' }];
    attachTagsToImages([{ id: 2 }], tags);

    expect(tags).toEqual([{ imageId: 2, name: 'a' }]);
  });
});

// ---------------------------------------------------------------------------
// The two call sites, end to end
// ---------------------------------------------------------------------------

/** Minimal rows in the shape each service's `$queryRaw` returns. */
const baseRow = {
  name: 'x',
  url: 'x',
  nsfwLevel: 1,
  width: 1,
  height: 1,
  hash: 'x',
  hideMeta: false,
  hasMeta: true,
  hasPositivePrompt: true,
  createdAt: new Date(0),
  mimeType: 'image/jpeg',
  type: 'image',
  metadata: null,
  ingestion: 'Scanned',
  scannedAt: new Date(0),
  needsReview: null,
  userId: 1,
  index: 0,
};

/** Shapes `imageTagsCache.fetch`'s return so `getImageTagsForImages` builds tags. */
function cachedTags(byImage: Record<number, string[]>) {
  return Object.fromEntries(
    Object.entries(byImage).map(([imageId, names]) => [
      imageId,
      {
        imageId: Number(imageId),
        tags: names.map((tagName, i) => ({
          tagId: 1000 + i,
          tagName,
          tagType: 'UserGenerated',
          tagNsfwLevel: 1,
          score: 1,
          upVotes: 0,
          downVotes: 0,
        })),
      },
    ])
  );
}

describe('getImagesByEntity associates tags per image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives each image its own tags and [] to the untagged one', async () => {
    const rows = [
      { ...baseRow, id: 70, entityId: 1, poi: false, minor: false },
      { ...baseRow, id: 41, entityId: 1, poi: false, minor: false },
      { ...baseRow, id: 93, entityId: 1, poi: false, minor: false },
    ];
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    // 41 is deliberately absent: it is the empty case, in the middle.
    imageTagsFetch.mockResolvedValue(cachedTags({ 70: ['a1', 'a2'], 93: ['c1'] }));

    const result = await getImagesByEntity({ id: 1, type: 'Bounty', include: ['tags'] });

    // Positive control: an early return would make every assertion below a
    // statement about nothing.
    expect(result, 'getImagesByEntity returned no rows').toHaveLength(3);
    expect(imageTagsFetch, 'the tag fetch never ran').toHaveBeenCalledTimes(1);

    expect(result[0].tags.map((t) => t.name)).toEqual(['a1', 'a2']);
    expect(result[1].tags, 'an image with no tags must receive [], not undefined').toEqual([]);
    expect(result[2].tags.map((t) => t.name)).toEqual(['c1']);
    expect(result.map((r) => r.id)).toEqual([70, 41, 93]);
  });

  it('returns [] for every image when tags were not requested', async () => {
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...baseRow, id: 70, entityId: 1, poi: false, minor: false },
    ]);

    const result = await getImagesByEntity({ id: 1, type: 'Bounty' });

    expect(result).toHaveLength(1);
    expect(imageTagsFetch).not.toHaveBeenCalled();
    expect(result[0].tags, 'no `include` must still yield [], as `.filter()` did').toEqual([]);
  });
});

describe('getEntityCoverImage associates tags per image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives each image its own tags, [] to the untagged one, and keeps cosmetic', async () => {
    const rows = [
      { ...baseRow, id: 70, postId: null, entityId: 11, entityType: 'Model' },
      { ...baseRow, id: 41, postId: null, entityId: 22, entityType: 'Model' },
      { ...baseRow, id: 93, postId: null, entityId: 33, entityType: 'Model' },
    ];
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    imageTagsFetch.mockResolvedValue(cachedTags({ 70: ['a1', 'a2'], 93: ['c1'] }));

    const result = await getEntityCoverImage({
      entities: [
        { entityId: 11, entityType: 'Model' },
        { entityId: 22, entityType: 'Model' },
        { entityId: 33, entityType: 'Model' },
      ],
      include: ['tags'],
    });

    expect(result, 'getEntityCoverImage returned no rows').toHaveLength(3);
    expect(imageTagsFetch, 'the tag fetch never ran').toHaveBeenCalledTimes(1);

    expect(result[0].tags.map((t) => t.name)).toEqual(['a1', 'a2']);
    expect(result[1].tags, 'an image with no tags must receive [], not undefined').toEqual([]);
    expect(result[2].tags.map((t) => t.name)).toEqual(['c1']);

    // The cosmetic key is attached at this call site only; the rewrite must not
    // have dropped it.
    expect(result[0]).toHaveProperty('cosmetic');
  });
});
