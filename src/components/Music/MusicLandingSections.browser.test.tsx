import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type * as Trpc from '~/utils/trpc';

const server = vi.hoisted(() => ({
  music: true,
  rising: [] as number[],
  risingReads: [] as { enabled?: boolean }[],
  // What the image feed serves: a song left out stands for one the viewer may not see.
  catalog: [] as unknown[],
  imageReads: [] as { filters: { ids?: number[]; tags?: number[] }; enabled?: boolean }[],
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: server.music }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('../MusicPlayer/__tests__/song-covers-trpc-stub');
  const stubbed = withSongCoversStub(actual.trpc);
  const getRisingSongs = {
    useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
      server.risingReads.push({ enabled: options?.enabled });
      return { data: options?.enabled === false ? undefined : server.rising };
    },
  };
  const trpc = new Proxy(stubbed, {
    get: (target, key) =>
      key === 'image' ? { ...Reflect.get(target, key), getRisingSongs } : Reflect.get(target, key),
  });
  return { ...actual, trpc };
});
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useQueryImages: (
    filters: { ids?: number[]; tags?: number[] },
    options?: { enabled?: boolean }
  ) => {
    server.imageReads.push({ filters, enabled: options?.enabled });
    if (options?.enabled === false) return { images: [], isLoading: false };
    // In id order, as the database returns them, not in the order asked.
    const images = (server.catalog as { id: number; tagIds: number[] }[])
      .filter((image) => filters.ids?.includes(image.id))
      .filter(
        (image) => !filters.tags?.length || filters.tags.some((t) => image.tagIds.includes(t))
      )
      .sort((a, b) => a.id - b.id);
    return { images, isLoading: false };
  },
}));
vi.mock('~/components/Image/Providers/ImagesProvider', async () => {
  const React = await import('react');
  const Context = React.createContext<{ getImages: () => unknown[] | undefined } | null>(null);
  return {
    ImagesProvider: ({ images, children }: { images: unknown[]; children: ReactNode }) => (
      <Context.Provider value={{ getImages: () => images }}>{children}</Context.Provider>
    ),
    useImagesContext: () => React.useContext(Context) ?? { getImages: () => undefined },
  };
});
vi.mock('~/components/Music/SongContextMenu', () => ({
  SongContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { RecentlyPlayedSection, RisingSection } from '~/components/Music/MusicLandingSections';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import type { MusicList } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';

const SYNTHWAVE = 29;
const song = (id: number, tagIds: number[] = []) =>
  ({
    id,
    url: `song-${id}.mp3`,
    type: 'audio',
    tagIds,
    metadata: { title: `Song ${id}`, duration: 185 },
    user: { id: 100 + id, username: `artist${id}` },
    stats: { likeCountAllTime: 0, commentCountAllTime: 0 },
  } as unknown as ImagesInfiniteModel);
const catalog = Array.from({ length: 40 }, (_, i) => song(i + 1, i % 2 ? [SYNTHWAVE] : []));
const byId = (id: number) => catalog[id - 1];

const playFromList = vi.fn<(list: MusicList) => void>();

const heading = (name: string) => page.getByRole('heading', { name, level: 2 });
// Hidden ones included: a phone lays out only the first four Rising tiles.
const titles = () =>
  page
    .getByRole('button', { name: /^Play Song /, includeHidden: true })
    .elements()
    .map((el) => el.getAttribute('aria-label')?.replace('Play ', ''));

beforeEach(() => {
  server.music = true;
  server.rising = [];
  server.risingReads = [];
  server.catalog = catalog;
  server.imageReads = [];
  useMusicPlayerStore.getState().close();
  useMusicPlayerStore.setState({ recentlyPlayed: [], playFromList });
  playFromList.mockReset();
});

describe('Rising this week', () => {
  test('shows the most played songs in rank order, without the ones the viewer cannot see', async () => {
    // Song 9 is not served: removed, blocked or hidden for this viewer.
    server.rising = [3, 9, 1, 2];
    server.catalog = catalog.filter((s) => s.id !== 9);
    await renderWithProviders(<RisingSection />);

    await expect.element(heading('Rising this week')).toBeVisible();
    expect(titles()).toEqual(['Song 3', 'Song 1', 'Song 2']);
    expect(server.imageReads.at(-1)?.filters.ids).toEqual([3, 9, 1, 2]);
  });

  test('shows the top 7', async () => {
    server.rising = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    await renderWithProviders(<RisingSection />);

    await expect.element(heading('Rising this week')).toBeVisible();
    expect(titles()).toEqual([
      'Song 10',
      'Song 9',
      'Song 8',
      'Song 7',
      'Song 6',
      'Song 5',
      'Song 4',
    ]);
  });

  test('with a genre picked, lists that genre only', async () => {
    server.rising = [4, 1, 2, 3];
    await renderWithProviders(<RisingSection tags={[SYNTHWAVE]} />);

    await expect.element(heading('Rising this week')).toBeVisible();
    expect(titles()).toEqual(['Song 4', 'Song 2']);
  });

  test('without a genre reads only the top 25 ids', async () => {
    server.rising = Array.from({ length: 40 }, (_, i) => 40 - i);
    await renderWithProviders(<RisingSection />);
    await expect.element(heading('Rising this week')).toBeVisible();
    expect(server.imageReads.at(-1)?.filters.ids).toEqual(server.rising.slice(0, 25));
  });

  test('with a genre picked reads every id, since the genre filters after', async () => {
    server.rising = Array.from({ length: 40 }, (_, i) => 40 - i);
    await renderWithProviders(<RisingSection tags={[SYNTHWAVE]} />);
    await expect.element(heading('Rising this week')).toBeVisible();
    expect(server.imageReads.at(-1)?.filters.ids).toEqual(server.rising);
    expect(titles()).toHaveLength(7);
  });

  test('is hidden when no song was played this week', async () => {
    await renderWithProviders(<RisingSection />);
    expect(page.getByRole('heading').elements()).toHaveLength(0);
  });

  test('the 2nd song plays with the songs after it as Up next, "Rising this week"', async () => {
    server.rising = [3, 1, 2];
    await renderWithProviders(<RisingSection />);
    await page.getByRole('button', { name: 'Play Song 1' }).click();

    expect(playFromList).toHaveBeenCalledTimes(1);
    expect(playFromList).toHaveBeenCalledWith({
      name: 'Rising this week',
      tracks: [3, 1, 2].map((id) => songTrack(byId(id))),
      index: 1,
    });
  });
});

describe('Recently played', () => {
  test("shows this browser's last songs, newest first", async () => {
    useMusicPlayerStore.setState({ recentlyPlayed: [5, 2, 7] });
    await renderWithProviders(<RecentlyPlayedSection />);

    await expect.element(heading('Recently played')).toBeVisible();
    expect(titles()).toEqual(['Song 5', 'Song 2', 'Song 7']);
  });

  test('drops a song the image feed no longer serves (removed)', async () => {
    useMusicPlayerStore.setState({ recentlyPlayed: [5, 2, 7] });
    server.catalog = catalog.filter((s) => s.id !== 2);
    await renderWithProviders(<RecentlyPlayedSection />);

    await expect.element(heading('Recently played')).toBeVisible();
    expect(titles()).toEqual(['Song 5', 'Song 7']);
  });

  test('is hidden when nothing was played', async () => {
    await renderWithProviders(<RecentlyPlayedSection />);
    expect(page.getByRole('heading').elements()).toHaveLength(0);
  });

  test('the 2nd song plays with the songs after it as Up next, "Recently played"', async () => {
    useMusicPlayerStore.setState({ recentlyPlayed: [5, 2, 7] });
    await renderWithProviders(<RecentlyPlayedSection />);
    await page.getByRole('button', { name: 'Play Song 2' }).click();

    expect(playFromList).toHaveBeenCalledTimes(1);
    expect(playFromList).toHaveBeenCalledWith({
      name: 'Recently played',
      tracks: [5, 2, 7].map((id) => songTrack(byId(id))),
      index: 1,
    });
  });

  test('keeps its order on screen when a card is played (the played song moves up next visit)', async () => {
    useMusicPlayerStore.setState({ recentlyPlayed: [5, 2, 7] });
    // As the player does: the started song moves to the front of recently played.
    playFromList.mockImplementation(({ tracks, index }) => {
      const id = tracks[index].id;
      useMusicPlayerStore.setState((s) => ({
        recentlyPlayed: [id, ...s.recentlyPlayed.filter((other) => other !== id)],
      }));
    });
    await renderWithProviders(<RecentlyPlayedSection />);
    await page.getByRole('button', { name: 'Play Song 2' }).click();

    expect(useMusicPlayerStore.getState().recentlyPlayed).toEqual([2, 5, 7]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(titles()).toEqual(['Song 5', 'Song 2', 'Song 7']);
  });
});

describe('with the music flag off', () => {
  test('neither section reads anything', async () => {
    server.music = false;
    server.rising = [1];
    useMusicPlayerStore.setState({ recentlyPlayed: [1] });
    await renderWithProviders(
      <>
        <RecentlyPlayedSection />
        <RisingSection />
      </>
    );

    expect(page.getByRole('heading').elements()).toHaveLength(0);
    // Both sections asked, so the checks below cannot pass on no reads at all.
    expect(server.risingReads.length).toBeGreaterThan(0);
    expect(server.imageReads.length).toBeGreaterThan(0);
    expect(server.risingReads.every((read) => read.enabled === false)).toBe(true);
    expect(server.imageReads.every((read) => read.enabled === false)).toBe(true);
  });
});
