import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ComponentType, ReactNode } from 'react';
import { useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as ImageFeedSearch from '~/components/Image/Infinite/useImageFeedSearch';
import type * as MasonryColumnsVirtualModule from '~/components/MasonryColumns/MasonryColumnsVirtual';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

const feed = vi.hoisted(() => ({
  features: { music: true } as Record<string, boolean>,
  /** Draw the real masonry instead of a plain list of its items. */
  realMasonry: false,
  /** Off for image cards, which need providers these tests leave out. */
  drawItems: true,
  images: [] as unknown[],
  provided: [] as unknown[],
  masonry: undefined as
    | {
        imageDimensions: (data: unknown) => { width: number; height: number };
        adjustHeight: (
          args: { imageRatio: number; width: number; height: number },
          data: unknown
        ) => number;
      }
    | undefined,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => feed.features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import(
    '../../../MusicPlayer/__tests__/song-covers-trpc-stub'
  );
  // The covers and genre-map reads are stubbed; the rest of `trpc.image` stays real for the feed's query keys.
  const stub = withSongCoversStub(actual.trpc) as unknown as {
    image: { getSongCovers: unknown; getSongGenreTags: unknown };
    useQueries: unknown;
  };
  const image = new Proxy(actual.trpc.image, {
    get: (target, key) =>
      key === 'getSongCovers' || key === 'getSongGenreTags'
        ? stub.image[key]
        : Reflect.get(target, key),
  });
  const trpc = new Proxy(actual.trpc, {
    get: (target, key) =>
      key === 'image' ? image : key === 'useQueries' ? stub.useQueries : Reflect.get(target, key),
  });
  return { ...actual, trpc };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useImageFilters: () => ({}),
  useQueryImages: () => ({
    images: feed.images,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    hasNextPage: false,
    isRefetching: false,
    isFetching: false,
    isError: false,
  }),
}));
vi.mock('~/components/Image/Infinite/useImageFeedSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageFeedSearch>()),
  useSemanticImageFeed: () => ({ images: [], isError: false }),
}));
// The provider's batch fetches are not under test; the cards read the items it holds.
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ images, children }: { images: unknown[]; children: ReactNode }) => {
    feed.provided = images;
    return <>{children}</>;
  },
  useImagesContext: () => ({ getImages: () => feed.provided }),
}));
vi.mock('~/components/MasonryColumns/MasonryColumnsVirtual', async (importOriginal) => {
  const actual = await importOriginal<typeof MasonryColumnsVirtualModule>();
  const Real = actual.MasonryColumnsVirtual as unknown as ComponentType<Record<string, unknown>>;
  return {
    MasonryColumnsVirtual: (props: {
      data: { id: number }[];
      render: ComponentType<{ data: unknown; height: number }>;
      imageDimensions: (data: unknown) => { width: number; height: number };
      adjustHeight: (
        args: { imageRatio: number; width: number; height: number },
        data: unknown
      ) => number;
    }) => {
      const { data, render: Item, ...sizing } = props;
      feed.masonry = sizing;
      if (feed.realMasonry) return <Real {...props} />;
      return (
        <div data-testid="masonry">
          {feed.drawItems && data.map((d) => <Item key={d.id} data={d} height={360} />)}
        </div>
      );
    },
  };
});
vi.mock('~/components/Music/SongContextMenu', () => ({
  SongContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ImagesInfiniteContent } from '~/components/Image/Infinite/ImagesInfinite';
import { songCovers } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { adjustImagesCardHeight } from '~/components/Image/Infinite/images-card-footer';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { SONG_ROW_HEIGHT, SongRow } from '~/components/Music/SongRow';
import {
  MUSIC_FEED_COLUMN_WIDTH,
  SONG_CARD_TEXT_HEIGHT,
  SONG_COVER_RATIO,
} from '~/components/Music/song-card.constants';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import type { MusicList } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { renderWithProviders } from '../../../../../test/component-setup';

const song = (id: number, title: string) => ({
  id,
  url: `song-${id}.mp3`,
  type: 'audio',
  metadata: { title, duration: 120 },
  user: { id: 100 + id, username: `artist${id}` },
  stats: {},
  reactions: [],
});
const songs = [song(1, 'Midnight Arcade'), song(2, 'Palm Static'), song(3, 'Chrome Heart')];
const picture = { id: 50, type: 'image', width: 600, height: 900, user: { id: 9 } };

const playFromList = vi.fn<(list: MusicList) => void>();
const SONG_ROWS = { render: SongRow, height: SONG_ROW_HEIGHT };

// The page's scroll container, which the list view virtualizes against.
function ScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: ref as React.RefObject<HTMLDivElement> }}>
      <div ref={ref} data-testid="scroller" style={{ height: 600, overflowY: 'auto' }}>
        {children}
      </div>
    </ScrollAreaContext.Provider>
  );
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  feed.features = { music: true };
  feed.realMasonry = false;
  feed.drawItems = true;
  feed.masonry = undefined;
  useMusicPlayerStore.getState().close();
  playFromList.mockReset();
  useMusicPlayerStore.setState({ playFromList });
  feed.images = songs;
  songCovers.reset();
});

const expectPlayedFrom = (name: string) => {
  expect(playFromList).toHaveBeenCalledTimes(1);
  expect(playFromList).toHaveBeenCalledWith({
    name,
    tracks: songs.map((s) => songTrack(s as never)),
    index: 1,
  });
};

// The height the masonry gives `data` in a column `width` wide.
const sized = (data: unknown, width: number) => {
  const { imageDimensions, adjustHeight } = feed.masonry!;
  const { width: w, height: h } = imageDimensions(data);
  const height = (h / w) * width;
  return adjustHeight({ imageRatio: width / height, width, height }, data);
};

describe('songs in an image feed', () => {
  test("a collection's songs play as a list named after the collection", async () => {
    await renderWithProviders(
      <ImagesInfiniteContent disableStoreFilters collectionId={5} songListName="Summer mix" />
    );
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    expectPlayedFrom('Summer mix');
  });

  test('the list view draws the same items as rows, playing from the same list', async () => {
    await renderWithProviders(
      <ScrollArea>
        <ImagesInfiniteContent listItem={SONG_ROWS} songListName="All music" />
      </ScrollArea>
    );
    await expect
      .poll(() =>
        page
          .getByRole('listitem')
          .elements()
          .map((row) => row.textContent?.slice(0, 1))
      )
      .toEqual(['1', '2', '3']);
    await expect.element(page.getByText('Chrome Heart')).toBeInTheDocument();
    expect(page.getByTestId('masonry').query()).toBeNull();
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    expectPlayedFrom('All music');
  });

  test("one covers read serves every song in the list, the feed's other items left out", async () => {
    feed.images = [songs[0], { id: 50, type: 'image', user: { id: 9 } }, songs[1], songs[2]];
    await renderWithProviders(
      <ScrollArea>
        <ImagesInfiniteContent listItem={SONG_ROWS} songListName="All music" />
      </ScrollArea>
    );
    await expect.element(page.getByText('Chrome Heart')).toBeInTheDocument();
    expect(new Set(songCovers.requests.map((ids) => JSON.stringify(ids)))).toEqual(
      new Set([JSON.stringify([1, 2, 3])])
    );
  });

  test('the list view renders only the rows near the viewport of a long list', async () => {
    feed.images = Array.from({ length: 300 }, (_, i) => song(i + 1, `Song ${i + 1}`));
    await renderWithProviders(
      <ScrollArea>
        <ImagesInfiniteContent listItem={SONG_ROWS} songListName="All music" />
      </ScrollArea>
    );
    await expect.element(page.getByText('Song 1', { exact: true })).toBeInTheDocument();
    expect(page.getByRole('listitem').elements().length).toBeLessThan(40);
    expect(page.getByText('Song 300', { exact: true }).query()).toBeNull();
  });

  test('the grid gives every song the Song Card shape, whatever the file reports', async () => {
    await renderWithProviders(<ImagesInfiniteContent songListName="All music" />);
    await expect.poll(() => feed.masonry).toBeDefined();
    const wide = { ...songs[0], width: 1920, height: 1080 };
    expect(sized(wide, 213)).toBeCloseTo(200 + SONG_CARD_TEXT_HEIGHT);
    expect(sized(songs[1], 320)).toBeCloseTo(320 * SONG_COVER_RATIO + SONG_CARD_TEXT_HEIGHT);
  });

  test('in a single column, a song is sized at the width it is drawn at', async () => {
    await page.viewport(390, 800);
    await renderWithProviders(<ImagesInfiniteContent songListName="All music" />);
    await expect.poll(() => feed.masonry).toBeDefined();
    const drawn = page
      .getByTestId('masonry')
      .element()
      .parentElement!.getBoundingClientRect().width;
    expect(drawn).toBeLessThan(213 * 2 + 16);
    expect(sized(songs[0], 213)).toBeCloseTo(
      Math.min(drawn, 450) * SONG_COVER_RATIO + SONG_CARD_TEXT_HEIGHT
    );
  });

  test('in a single column wider than 450, a song is sized at the 450 the column is drawn at', async () => {
    await renderWithProviders(
      <div style={{ width: 600 }}>
        <ImagesInfiniteContent songListName="All music" />
      </div>
    );
    await expect.poll(() => feed.masonry).toBeDefined();
    expect(sized(songs[0], 320)).toBeCloseTo(450 * SONG_COVER_RATIO + SONG_CARD_TEXT_HEIGHT);
  });

  test("a single column's songs take the new height when the feed is resized", async () => {
    feed.realMasonry = true;
    await renderWithProviders(
      <ScrollArea>
        <div data-testid="frame" style={{ width: 400 }}>
          <MasonryProvider columnWidth={MUSIC_FEED_COLUMN_WIDTH}>
            <ImagesInfiniteContent songListName="All music" />
          </MasonryProvider>
        </div>
      </ScrollArea>
    );
    const slotHeight = () => {
      const slot = document.querySelector('[data-masonry-item]');
      return slot ? slot.getBoundingClientRect().height - 2 * ITEM_BLEED : undefined;
    };
    const songHeight = (width: number) =>
      Math.floor(width * SONG_COVER_RATIO + SONG_CARD_TEXT_HEIGHT);
    await expect.poll(slotHeight).toBe(songHeight(400));

    page.getByTestId('frame').element().setAttribute('style', 'width: 300px');
    await expect.poll(slotHeight).toBe(songHeight(300));
  });

  test('an image in the same feed keeps the image card height', async () => {
    await renderWithProviders(<ImagesInfiniteContent songListName="All music" />);
    await expect.poll(() => feed.masonry).toBeDefined();
    const { width, height } = feed.masonry!.imageDimensions(picture);
    const args = { imageRatio: width / height, width: 300, height: (height / width) * 300 };
    expect(feed.masonry!.adjustHeight(args, picture)).toBe(adjustImagesCardHeight(args));
  });
});

describe('the list view, scrolled', () => {
  test('drops the rows above the viewport and places the ones in it', async () => {
    feed.images = Array.from({ length: 300 }, (_, i) => song(i + 1, `Song ${i + 1}`));
    await renderWithProviders(
      <ScrollArea>
        <ImagesInfiniteContent listItem={SONG_ROWS} songListName="All music" />
      </ScrollArea>
    );
    await expect.element(page.getByText('Song 1', { exact: true })).toBeInTheDocument();
    const list = page.getByRole('list').element();
    const scroller = page.getByTestId('scroller').element();
    scroller.scrollTop = SONG_ROW_HEIGHT * 150;
    scroller.dispatchEvent(new Event('scroll'));

    await expect.element(page.getByText('Song 151', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Song 1', { exact: true }).query()).toBeNull();
    const row = page.getByText('Song 151', { exact: true }).element().closest('[role="listitem"]')!;
    const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    expect(offset).toBeCloseTo(SONG_ROW_HEIGHT * 150);
  });
});

describe('an image feed with the music flag', () => {
  test('draws its grid on the first render, even in a container with no width yet', async () => {
    feed.images = [picture];
    feed.drawItems = false;
    await renderWithProviders(
      <div style={{ width: 0 }}>
        <ImagesInfiniteContent />
      </div>
    );
    expect(page.getByTestId('masonry').query()).not.toBeNull();
  });
});

describe('an image feed without the music flag', () => {
  test('sizes a song as any other item and draws the grid straight in the feed', async () => {
    feed.features = {};
    feed.images = [songs[0], picture];
    feed.drawItems = false;
    await renderWithProviders(<ImagesInfiniteContent />);
    const masonry = page.getByTestId('masonry').element();
    expect(masonry.parentElement!.style.position).toBe('relative');
    const { width, height } = feed.masonry!.imageDimensions(songs[0]);
    expect({ width, height }).toEqual({ width: 450, height: 450 });
    const args = { imageRatio: 1, width: 300, height: 300 };
    expect(feed.masonry!.adjustHeight(args, songs[0])).toBe(adjustImagesCardHeight(args));
  });
});
