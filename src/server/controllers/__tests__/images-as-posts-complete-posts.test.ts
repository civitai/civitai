import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';

/**
 * The gallery pages by image, so under an image-level sort the first page can hold only some of a
 * post's images. Each post on a page is completed from further fetches that carry the page's own
 * filters, so the first paint shows the whole post and the completion never shows an image the page
 * query would have hidden.
 */
type Row = { id: number; postId: number; nsfwLevel: number; index: number };
let rows: Row[] = [];
// The image-level page ranks only these images; the rest of their posts rank on a later page.
let firstPageIds: number[] = [];

const { fetches } = vi.hoisted(() => ({ fetches: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  filterPinnedImagesToVersion: async (images: unknown[]) => images,
}));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => ({ pinnedPosts: {}, hiddenImages: {} }),
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => undefined,
}));

const { getImagesAsPostsInfiniteHandler } = await import('~/server/controllers/image.controller');

type FetchArgs = { postIds?: number[]; cursor?: string; limit: number; browsingLevel: number };

const toImage = (row: Row) => ({
  ...row,
  sortAt: new Date('2026-10-01'),
  user: { id: 1 },
  stats: {},
});

// Post 500 has eight public images and one above the viewer's level; post 600 has two.
const smallGallery = () => {
  rows = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, postId: 500, nsfwLevel: 1, index: id })),
    { id: 9, postId: 500, nsfwLevel: 4, index: 9 },
    ...[10, 11].map((id) => ({ id, postId: 600, nsfwLevel: 1, index: id })),
  ];
  firstPageIds = [1, 2, 10];
};

beforeEach(() => {
  vi.clearAllMocks();
  smallGallery();
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
  fetches.mockImplementation(async (args: FetchArgs) => {
    const visible = rows.filter((row) => row.nsfwLevel & args.browsingLevel);
    if (args.postIds)
      return { items: visible.filter((r) => args.postIds?.includes(r.postId)).map(toImage) };
    return {
      items: visible.filter((r) => firstPageIds.includes(r.id)).map(toImage),
      nextCursor: 'next-page',
    };
  });
});

const run = (features = {}) =>
  getImagesAsPostsInfiniteHandler({
    input: {
      limit: 2,
      modelId: 1,
      modelVersionId: 10,
      include: [],
      browsingLevel: 1,
      sort: 'Most Reactions',
    } as never,
    ctx: {
      user: { id: 5 },
      features: { imageIndexFeed: true, ...features },
      req: { headers: {} },
    } as never,
  });

const calls = () => fetches.mock.calls.map((c) => c[0] as FetchArgs & Record<string, unknown>);

describe('getImagesAsPostsInfiniteHandler post completion', () => {
  it('returns the whole post on the first page', async () => {
    const { items } = await run();
    expect(items.find((p) => p.postId === 500)?.images.map((i) => i.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(items.find((p) => p.postId === 600)?.images.map((i) => i.id)).toEqual([10, 11]);
  });

  it('keeps an image the page query would hide hidden', async () => {
    const { items } = await run();
    expect(items.flatMap((p) => p.images.map((i) => i.id))).not.toContain(9);
  });

  it('completes with the page query filters, for only the page posts, bounded per post', async () => {
    await run();
    const [page, completion] = calls();
    expect(completion.postIds?.slice().sort()).toEqual([500, 600]);
    expect(completion.cursor).toBeUndefined();
    expect(completion.limit).toBe(2 * 20);
    const { cursor, limit, postIds, ...pageFilters } = page;
    const { cursor: c2, limit: l2, postIds: p2, ...completionFilters } = completion;
    expect(completionFilters).toEqual(pageFilters);
  });

  // With lazy post images the card carries a first slice and the post's true count, which the
  // carousel loads the rest from; a count taken from the page alone is what stranded a card at two.
  it('gives a lazy card the whole post count, not the count of its page', async () => {
    const { items } = await run({ galleryLazyPostImages: true });
    const post = items.find((p) => p.postId === 500);
    expect(post?.imageCount).toBe(8);
    expect(post?.images.length).toBeLessThan(8);
    expect(items.find((p) => p.postId === 600)?.imageCount).toBe(2);
  });

  it('asks for no more than a bounded number of posts at a time', async () => {
    rows = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      postId: 1000 + i,
      nsfwLevel: 1,
      index: 0,
    }));
    firstPageIds = rows.map((r) => r.id);
    const { items } = await run();
    const completions = calls().filter((c) => c.postIds);
    expect(completions.length).toBeGreaterThan(1);
    for (const c of completions) expect(c.postIds?.length).toBeLessThanOrEqual(25);
    expect(items).toHaveLength(60);
  });
});
