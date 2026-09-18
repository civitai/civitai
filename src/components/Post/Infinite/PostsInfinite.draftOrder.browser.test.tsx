import React, { useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as PostUtils from '~/components/Post/post.utils';
import type * as FeedWrapper from '~/components/Feed/FeedWrapper';

// The drafts/scheduled feed must read left to right in publish order (CU 868m6k1ju).
//
// Height-balanced masonry puts each card in whichever column is currently shortest, so the
// server's order only survives DOWN a column — a reader taking a row left to right gets
// "6h, 7h, 8h" then "5h, 4h, 3h". Whoever replaces the grid here with a masonry layout
// again will fail this test: it asserts DOM order equals server order, which a
// column-balanced layout cannot satisfy once the cards differ in height.
//
// The published feed keeps masonry, and the second case below is what says so.

vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Ads/ads.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsUtils>()),
  useCreateAdFeed: () => (args: { data: unknown[] }) =>
    args.data.map((item) => ({ type: 'data' as const, data: item })),
}));
vi.mock('~/components/Feed/FeedWrapper', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedWrapper>()),
  FeedWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Card heights are what make the two layouts differ, so the stand-in card renders the
// post's own image height rather than a constant.
vi.mock('~/components/Post/Infinite/PostsCard', () => ({
  PostsCard: () => null,
  PostsCardMemoized: ({ data }: { data: { id: number; images: { height: number }[] } }) => (
    <div data-testid="post" data-id={data.id} style={{ height: data.images[0].height }} />
  ),
}));

// Descending publish order, the order the server returns: 3d, 2d, 8h, 7h, 6h, 5h, 40m.
// Heights vary the way real posts do, which is the input masonry reorders on.
// Ten, not nine: three columns in this harness, so the last row is ragged and the
// grid's end-of-list slice is exercised.
const heights = [420, 180, 300, 520, 200, 360, 240, 480, 220, 340];
const posts = heights.map((height, i) => ({
  id: i + 1,
  images: [{ id: i + 1, width: 300, height }],
}));

const feed = vi.hoisted(() => ({ posts: [] as { id: number; images: { height: number }[] }[] }));

vi.mock('~/components/Post/post.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof PostUtils>()),
  usePostFilters: () => ({}),
  useQueryPosts: () => ({
    posts: feed.posts,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isRefetching: false,
    isFetching: false,
  }),
}));

beforeEach(() => {
  feed.posts = posts;
});

function Feed({ draftOnly }: { draftOnly: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div ref={scrollRef} style={{ height: 2000, width: 1000, overflowY: 'auto' }}>
        <ContainerProvider containerName="test" style={{ width: 1000 }}>
          <MasonryProvider columnWidth={300} maxColumnCount={6} style={{ width: 1000 }}>
            <PostsInfinite filters={{ draftOnly }} disableStoreFilters />
          </MasonryProvider>
        </ContainerProvider>
      </div>
    </ScrollAreaContext.Provider>
  );
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="post"]'));
const renderedIds = () => cards().map((card) => Number(card.getAttribute('data-id')));
const columnCount = () => new Set(cards().map((card) => card.getBoundingClientRect().left)).size;
const serverOrder = posts.map((post) => post.id);
// What height-balanced masonry does to that order in this harness's three columns.
const MASONRY_ORDER = [1, 6, 10, 2, 4, 8, 3, 5, 7, 9];

describe('drafts feed order', () => {
  test('renders the server order left to right', async () => {
    renderWithProviders(<Feed draftOnly />);

    await vi.waitFor(() => expect(cards().length).toBe(posts.length));
    expect(renderedIds()).toEqual(serverOrder);
    // With one column every layout agrees and the assertion above proves nothing, so fail
    // here rather than passing vacuously. Keep it AFTER the order check: a column-balanced
    // layout should be reported as the wrong order, not as an unmeasurable one.
    expect(columnCount()).toBeGreaterThan(1);

    // Document order is not reading order: `direction: rtl` or a grid `order` would keep the
    // ids above in sequence while the queue read backwards. Assert the geometry too.
    const boxes = cards().map((card) => card.getBoundingClientRect());
    const firstRow = boxes.filter((box) => box.top === boxes[0].top);
    expect(firstRow.length).toBe(columnCount());
    expect(firstRow.map((box) => box.left)).toEqual(
      firstRow
        .map((box) => box.left)
        .slice()
        .sort((a, b) => a - b)
    );
    expect(boxes[columnCount()].top).toBeGreaterThan(boxes[0].top);
  });

  test('leaves the published feed on masonry', async () => {
    renderWithProviders(<Feed draftOnly={false} />);

    await vi.waitFor(() => expect(cards().length).toBe(posts.length));
    // Masonry's columns are flex children, and component tests load no stylesheet, so its
    // geometry cannot be measured here. Its grouping is plain JS though, and that is what
    // reorders the ids: the published feed is still on the layout that does it.
    expect(
      renderedIds()
        .slice()
        .sort((a, b) => a - b)
    ).toEqual(serverOrder);
    // The grouping is deterministic for these heights, so pin the permutation rather than
    // "not the server order" — a negative would also accept a DIFFERENT wrong grouping.
    expect(renderedIds()).toEqual(MASONRY_ORDER);
  });

  // Each mounted card installs a 15s interval for its countdown (mocked out here, so this
  // case bounds the count rather than observing the cost). The grid windows its rows, so the
  // count follows the viewport, not the queue: ~90 on a wide desktop, 200 without windowing.
  test('mounts a window, not the whole queue, at 200 posts', async () => {
    feed.posts = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      images: [{ id: i + 1, width: 300, height: 300 }],
    }));
    renderWithProviders(<Feed draftOnly />);

    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(cards().length).toBeLessThan(60);
    // Bounded from below too: a collapsed window — one row, or columnCount briefly 0 — is a
    // feed that goes blank on scroll, and it satisfies every upper bound.
    expect(cards().length).toBeGreaterThanOrEqual(columnCount() * 2);
    expect(renderedIds()[0]).toBe(1);
  });
});
