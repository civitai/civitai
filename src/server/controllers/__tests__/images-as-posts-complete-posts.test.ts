import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';

/**
 * The gallery pages by image, so under an image-level sort the first page can hold only some of a
 * post's images. A post whose row count says it has more is completed from further fetches that
 * carry the page's own filters, so the first paint shows the whole post and the completion never
 * shows an image the page query would have hidden. A post already whole on the page costs no fetch.
 */
type Row = { id: number; postId: number; nsfwLevel: number; index: number };
let rows: Row[] = [];
// The image-level page ranks only these images; the rest of their posts rank on a later page.
let firstPageIds: number[] = [];

const { fetches, rowCounts } = vi.hoisted(() => ({ fetches: vi.fn(), rowCounts: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  getPostImageCounts: rowCounts,
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

// Post 500: eight public images and one above the viewer's level, two of them on the first page.
// Post 600: two images, one on the page. Post 700: a single image. Post 800: two images, both on
// the page.
const smallGallery = () => {
  rows = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, postId: 500, nsfwLevel: 1, index: id })),
    { id: 9, postId: 500, nsfwLevel: 4, index: 9 },
    ...[10, 11].map((id) => ({ id, postId: 600, nsfwLevel: 1, index: id })),
    { id: 20, postId: 700, nsfwLevel: 1, index: 1 },
    ...[30, 31].map((id) => ({ id, postId: 800, nsfwLevel: 1, index: id })),
  ];
  firstPageIds = [1, 2, 10, 20, 30, 31];
};

beforeEach(() => {
  vi.clearAllMocks();
  smallGallery();
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
  rowCounts.mockImplementation(async ({ postIds }: { postIds: number[] }) => {
    const counts = new Map<number, number>();
    for (const row of rows)
      if (postIds.includes(row.postId)) counts.set(row.postId, (counts.get(row.postId) ?? 0) + 1);
    return counts;
  });
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
const completionCalls = () => calls().filter((c) => c.postIds);
const idsOf = (items: Awaited<ReturnType<typeof run>>['items'], postId: number) =>
  items.find((p) => p.postId === postId)?.images.map((i) => i.id);

describe('getImagesAsPostsInfiniteHandler post completion', () => {
  it('returns the whole post on the first page', async () => {
    const { items } = await run();
    expect(idsOf(items, 500)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(idsOf(items, 600)).toEqual([10, 11]);
    expect(idsOf(items, 700)).toEqual([20]);
    expect(idsOf(items, 800)).toEqual([30, 31]);
  });

  it('keeps an image the page query would hide hidden', async () => {
    const { items } = await run();
    expect(items.flatMap((p) => p.images.map((i) => i.id))).not.toContain(9);
  });

  it('fetches again only the posts whose row count exceeds what the page holds', async () => {
    await run();
    const completions = completionCalls();
    expect(completions).toHaveLength(1);
    expect(completions[0].postIds?.slice().sort()).toEqual([500, 600]);
  });

  it('completes with the page query filters, bounded by the posts row counts', async () => {
    await run();
    const [page] = calls();
    const [completion] = completionCalls();
    expect(completion.cursor).toBeUndefined();
    expect(completion.limit).toBe(9 + 2);
    const { cursor, limit, postIds, ...pageFilters } = page;
    const { cursor: c2, limit: l2, postIds: p2, ...completionFilters } = completion;
    expect(completionFilters).toEqual(pageFilters);
  });

  it('makes no completion fetch when every post is already whole on the page', async () => {
    firstPageIds = [10, 11, 20, 30, 31];
    await run();
    expect(completionCalls()).toHaveLength(0);
  });

  it('completes every post when the row counts cannot be read', async () => {
    rowCounts.mockRejectedValue(new Error('statement timeout'));
    const { items } = await run();
    expect(
      completionCalls()
        .flatMap((c) => c.postIds ?? [])
        .sort()
    ).toEqual([500, 600, 700, 800]);
    expect(idsOf(items, 500)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
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
    rows = Array.from({ length: 60 }, (_, i) => [
      { id: 2 * i + 1, postId: 1000 + i, nsfwLevel: 1, index: 0 },
      { id: 2 * i + 2, postId: 1000 + i, nsfwLevel: 1, index: 1 },
    ]).flat();
    firstPageIds = rows.filter((r) => r.id % 2 === 1).map((r) => r.id);
    const { items } = await run();
    const completions = completionCalls();
    expect(completions.length).toBeGreaterThan(1);
    for (const c of completions) expect(c.postIds?.length).toBeLessThanOrEqual(25);
    expect(items).toHaveLength(60);
    expect(items.every((p) => p.images.length === 2)).toBe(true);
  });
});
