import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as ImageFeedSearch from '~/components/Image/Infinite/useImageFeedSearch';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

const feed = vi.hoisted(() => ({ images: [] as unknown[], provided: [] as unknown[] }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import(
    '../../../MusicPlayer/__tests__/song-covers-trpc-stub'
  );
  // The covers reads are stubbed; the rest of `trpc.image` stays real for the feed's query keys.
  const stub = withSongCoversStub(actual.trpc) as unknown as {
    image: { getSongCovers: unknown };
    useQueries: unknown;
  };
  const image = new Proxy(actual.trpc.image, {
    get: (target, key) =>
      key === 'getSongCovers' ? stub.image.getSongCovers : Reflect.get(target, key),
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
vi.mock('~/components/MasonryColumns/MasonryColumnsVirtual', () => ({
  MasonryColumnsVirtual: ({
    data,
    render: Item,
  }: {
    data: { id: number }[];
    render: ComponentType<{ data: unknown; height: number }>;
  }) => (
    <div data-testid="masonry">
      {data.map((d) => (
        <Item key={d.id} data={d} height={360} />
      ))}
    </div>
  ),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ImagesInfiniteContent } from '~/components/Image/Infinite/ImagesInfinite';
import { songCovers } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { SongRow } from '~/components/Music/SongRow';
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

const playFromList = vi.fn<(list: MusicList) => void>();

beforeEach(() => {
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
      <ImagesInfiniteContent listItem={SongRow} songListName="All music" />
    );
    await expect.element(page.getByText('Chrome Heart')).toBeInTheDocument();
    expect(page.getByTestId('masonry').query()).toBeNull();
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    expectPlayedFrom('All music');
  });

  test("one covers read serves every song in the list, the feed's other items left out", async () => {
    feed.images = [songs[0], { id: 50, type: 'image', user: { id: 9 } }, songs[1], songs[2]];
    await renderWithProviders(<ImagesInfiniteContent listItem={SongRow} songListName="All music" />);
    await expect.element(page.getByText('Chrome Heart')).toBeInTheDocument();
    expect(new Set(songCovers.requests.map((ids) => JSON.stringify(ids)))).toEqual(
      new Set([JSON.stringify([1, 2, 3])])
    );
  });
});
