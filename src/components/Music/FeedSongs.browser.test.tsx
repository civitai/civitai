import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type * as Trpc from '~/utils/trpc';

const feed = vi.hoisted(() => ({ images: [] as unknown[] }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('../MusicPlayer/__tests__/song-covers-trpc-stub');
  return { ...actual, trpc: withSongCoversStub(actual.trpc) };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
// The feed's loaded items, as `ImagesInfinite` hands them to its cards.
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => feed.images }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { SongListNameProvider } from '~/components/Music/FeedSongList';
import { SongCard } from '~/components/Music/SongCard';
import { SongRow } from '~/components/Music/SongRow';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import type { MusicList } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';

const song = (id: number, title: string) =>
  ({
    id,
    url: `song-${id}.mp3`,
    type: 'audio',
    metadata: { title, duration: 185, genre: 'Synthwave' },
    user: { id: 100 + id, username: `artist${id}` },
    stats: { likeCountAllTime: 3, commentCountAllTime: 1 },
  } as unknown as ImagesInfiniteModel);
const image = { id: 50, url: 'pic.png', type: 'image', user: { id: 9 } } as ImagesInfiniteModel;
const songs = [song(1, 'Midnight Arcade'), song(2, 'Palm Static'), song(3, 'Chrome Heart')];

const playFromList = vi.fn<(list: MusicList) => void>();
const realPlayFromList = useMusicPlayerStore.getState().playFromList;

beforeEach(() => {
  useMusicPlayerStore.getState().close();
  playFromList.mockReset();
  playFromList.mockImplementation((list) => realPlayFromList(list));
  useMusicPlayerStore.setState({ playFromList });
  // A mixed feed: the image between the songs is not part of the list.
  feed.images = [songs[0], image, songs[1], songs[2]];
});

async function playSecondSong() {
  await page.getByRole('button', { name: 'Play Palm Static' }).click();
  // The next page arrives after the click.
  feed.images = [...feed.images, song(4, 'Rain on Shibuya')];
}

function expectPlayedFrom(name: string) {
  expect(playFromList).toHaveBeenCalledTimes(1);
  expect(playFromList).toHaveBeenCalledWith({ name, tracks: songs.map(songTrack), index: 1 });
  expect(useMusicPlayerStore.getState().list.map((t) => t.title)).toEqual(['Chrome Heart']);
}

describe('songs in a feed fill Up next from the feed', () => {
  test('card view: the 2nd song plays with the loaded songs after it', async () => {
    await renderWithProviders(
      <SongListNameProvider name="All music">
        {songs.map((s) => (
          <SongCard key={s.id} data={s} height={360} />
        ))}
      </SongListNameProvider>
    );
    await playSecondSong();
    expectPlayedFrom('All music');
  });

  test('list view: the 2nd row plays with the loaded songs after it', async () => {
    await renderWithProviders(
      <SongListNameProvider name="Synthwave">
        {songs.map((s, i) => (
          <SongRow key={s.id} data={s} index={i} />
        ))}
      </SongListNameProvider>
    );
    await playSecondSong();
    expectPlayedFrom('Synthwave');
  });

  test('a song in a feed with no list name plays from "Images"', async () => {
    await renderWithProviders(<SongCard data={songs[1]} height={360} />);
    await playSecondSong();
    expectPlayedFrom('Images');
  });
});

describe('the Song Card', () => {
  test('shows the title, creator, genre and length', async () => {
    await renderWithProviders(<SongCard data={songs[0]} height={360} />);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'artist1' })).toBeInTheDocument();
    await expect.element(page.getByText('Synthwave')).toBeInTheDocument();
    await expect.element(page.getByText('3:05')).toBeInTheDocument();
  });
});
