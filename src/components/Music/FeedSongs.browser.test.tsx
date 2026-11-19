import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type * as Trpc from '~/utils/trpc';

const feed = vi.hoisted(() => ({ images: [] as unknown[], music: true }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: feed.music }),
}));

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

import { FeedSongsProvider, SongListNameProvider } from '~/components/Music/FeedSongList';
import { songCovers, songPlays } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { SongCard } from '~/components/Music/SongCard';
import { SongRow } from '~/components/Music/SongRow';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { MUSIC_PLAYER_RESUME_KEY, resumeMusicPlayer } from '~/store/music-player-resume';
import type { MusicList } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

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
  feed.music = true;
  songCovers.reset();
  songPlays.reset();
  useMusicPlayheadStore.setState({ currentTime: 0, duration: 0 });
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

describe('a song the player already has', () => {
  // What a reload leaves: the last song loaded paused at its saved spot, with no list.
  async function reloadWithSavedSong(saved: ImagesInfiniteModel, positionSec: number) {
    const storage = new Map([
      [MUSIC_PLAYER_RESUME_KEY, JSON.stringify({ track: songTrack(saved), positionSec })],
    ]);
    await resumeMusicPlayer({
      store: useMusicPlayerStore,
      fetchSong: async () => saved as never,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
        removeItem: (key) => void storage.delete(key),
      },
    });
    // The audio element reports the restored spot once it loads.
    useMusicPlayheadStore.setState({ currentTime: positionSec });
  }

  const renderCollection = () =>
    renderWithProviders(
      <SongListNameProvider name="T8a e2e mix">
        {songs.map((s) => (
          <SongCard key={s.id} data={s} height={360} />
        ))}
      </SongListNameProvider>
    );

  test('restored after a reload, it plays from the list it is pressed in, where it was', async () => {
    feed.images = songs;
    await reloadWithSavedSong(songs[1], 42);
    expect(useMusicPlayerStore.getState().current?.id).toBe(2);
    await renderCollection();
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    const player = useMusicPlayerStore.getState();
    expect(player.playing).toBe(true);
    expect(player.listName).toBe('T8a e2e mix');
    expect(player.list.map((t) => t.title)).toEqual(['Chrome Heart']);
    expect(player.playback?.startAtSec).toBe(42);
  });

  test('left paused by a different list, it plays from this list, where it was', async () => {
    feed.images = songs;
    realPlayFromList({
      name: 'Rising this week',
      tracks: [songs[1], song(9, 'Elsewhere')].map(songTrack),
      index: 0,
    });
    useMusicPlayerStore.getState().pause();
    useMusicPlayheadStore.setState({ currentTime: 17 });
    await renderCollection();
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    const player = useMusicPlayerStore.getState();
    expect(player.playing).toBe(true);
    expect(player.listName).toBe('T8a e2e mix');
    expect(player.list.map((t) => t.title)).toEqual(['Chrome Heart']);
    expect(player.playback?.startAtSec).toBe(17);
  });

  test('pressed again in the same list, it pauses and resumes without restarting the list', async () => {
    feed.images = songs;
    await renderCollection();
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    await page.getByRole('button', { name: 'Pause Palm Static' }).click();
    expect(useMusicPlayerStore.getState().playing).toBe(false);
    await page.getByRole('button', { name: 'Play Palm Static' }).click();
    expect(useMusicPlayerStore.getState().playing).toBe(true);
    expect(playFromList).toHaveBeenCalledTimes(1);
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

  test('shows the play count, read once for the whole feed', async () => {
    songPlays.served = { 1: 9700, 2: 4 };
    await renderWithProviders(
      <FeedSongsProvider images={songs}>
        {songs.map((s) => (
          <SongCard key={s.id} data={s} height={360} />
        ))}
      </FeedSongsProvider>
    );
    await expect.element(page.getByLabelText('9700 plays')).toHaveTextContent('9.7k');
    await expect.element(page.getByLabelText('4 plays')).toBeInTheDocument();
    // Song 3 has no answer: no count rather than a made-up 0.
    expect(page.getByLabelText(/plays$/).elements()).toHaveLength(2);
    expect(songPlays.requests).toEqual([[1, 2, 3]]);
  });
});

describe('the Song Row', () => {
  test('shows the play count', async () => {
    songPlays.served = { 1: 12400 };
    await renderWithProviders(<SongRow data={songs[0]} index={0} />);
    await expect.element(page.getByLabelText('12400 plays')).toHaveTextContent('12.4k');
  });

  test('with the music flag off, reads no play count', async () => {
    feed.music = false;
    songPlays.served = { 1: 12400 };
    await renderWithProviders(<SongRow data={songs[0]} index={0} />);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    // The row's own cover read went out, so the row did read; only plays are held back.
    expect(songCovers.requests.length).toBeGreaterThan(0);
    expect(songPlays.requests).toEqual([]);
    expect(page.getByLabelText(/plays$/).elements()).toHaveLength(0);
  });
});
