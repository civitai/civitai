import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { constants } from '~/server/common/constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { renderWithProviders } from '../../../../../test/component-setup';

const state = vi.hoisted(() => ({
  feed: undefined as { filters: Record<string, unknown>; songListName?: string } | undefined,
  viewer: null as { id: number; username: string } | null,
  audioCount: 34,
  columnWidth: undefined as number | undefined,
}));

vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: true, showNsfw: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../../test/trpcProxyStub')).makeTrpcProxy({
    'userProfile.get': {
      useQuery: () => ({ data: { id: 7, username: 'Alice' }, isLoading: false }),
    },
    'userProfile.overview': {
      useQuery: (_input: unknown, opts?: { enabled?: boolean }) => ({
        data: opts?.enabled === false ? undefined : { audioCount: state.audioCount },
      }),
    },
  }),
}));
// What the profile asks its feed for, drawn as plain slots in the real masonry; the feed's own
// cards are covered by the ImagesInfinite tests.
const SLOTS = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
const Slot = () => <div data-testid="slot" className="size-full" />;
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({
  default: function Feed(props: { filters: Record<string, unknown>; songListName?: string }) {
    state.feed = props;
    state.columnWidth = useMasonryContext().columnWidth;
    return (
      <MasonryColumnsVirtual
        data={SLOTS}
        render={Slot}
        imageDimensions={() => ({ width: 1, height: 1 })}
        itemId={(slot) => slot.id}
      />
    );
  },
}));
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));

// The page's scroll container, which the masonry virtualizes against.
function ScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: ref as React.RefObject<HTMLDivElement> }}>
      <div ref={ref} style={{ height: 900, overflowY: 'auto' }}>
        {children}
      </div>
    </ScrollAreaContext.Provider>
  );
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  state.feed = undefined;
  state.columnWidth = undefined;
  state.viewer = null;
  state.audioCount = 34;
  useRouter().query = { username: 'alice' };
});

describe('the profile music tab', () => {
  test("lists only the creator's songs, playing them as a list named after the creator", async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);

    await expect.poll(() => state.feed?.filters.userId).toBe(7);
    expect(state.feed?.filters.types).toEqual([MediaType.audio]);
    expect(state.feed?.songListName).toBe('Alice');
  });

  test('keeps the Published / Draft toggle on the owner’s own profile', async () => {
    state.viewer = { id: 7, username: 'Alice' };
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);

    await expect.element(page.getByText('My Songs')).toBeVisible();
    await expect.element(page.getByText('Draft')).toBeVisible();
  });

  test("the owner's reactions view plays its songs as a list named after that view", async () => {
    state.viewer = { id: 7, username: 'Alice' };
    useRouter().query = { username: 'alice', section: 'reactions' };
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);

    await expect.poll(() => state.feed?.songListName).toBe('My Reactions');
  });

  test("shows the creator's song count above the songs", async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);
    await expect.element(page.getByText('34 songs')).toBeVisible();
  });

  test('counts a single song in the singular', async () => {
    state.audioCount = 1;
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);
    await expect.element(page.getByText('1 song', { exact: true })).toBeVisible();
  });

  test('lays four Song Cards across at 1440, 16 apart, flush with the toolbar (Pencil `CaAoU`)', async () => {
    // The profile body at 1440: the 320 sidebar and the layout's `px-3` sides taken off.
    renderWithProviders(
      <ScrollArea>
        <div style={{ width: 1440 - 320 - 2 * 12 }}>
          <UserMediaInfinite type={MediaType.audio} />
        </div>
      </ScrollArea>
    );
    await expect.poll(() => page.getByTestId('slot').elements().length).toBeGreaterThan(3);
    const toolbar = page.getByText('34 songs').element().parentElement!.parentElement!;
    const tops = page
      .getByTestId('slot')
      .elements()
      .map((el) => el.getBoundingClientRect())
      .filter((rect, _, all) => Math.round(rect.top) === Math.round(all[0].top))
      .sort((a, b) => a.left - b.left);
    expect(tops).toHaveLength(4);
    for (const rect of tops) expect(rect.width).toBeCloseTo(256, 0);
    expect(tops[1].left - tops[0].right).toBeCloseTo(16, 0);
    expect(tops[0].left).toBeCloseTo(toolbar.getBoundingClientRect().left, 0);
  });

  test.each([MediaType.image, MediaType.video])(
    'the %s tab keeps the image card width',
    async (type) => {
      renderWithProviders(<UserMediaInfinite type={type} />);
      await expect.poll(() => state.columnWidth).toBe(constants.cardSizes.image);
    }
  );

  test('the images tab names no song list', async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.poll(() => state.feed?.filters.userId).toBe(7);
    expect(state.feed?.songListName).toBeUndefined();
    expect(page.getByText(/\d+ songs?$/).query()).toBeNull();
  });
});
