import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: new Proxy(actual.trpc, {
      get: (target, key) =>
        key === 'image'
          ? { getSongCovers: { useQuery: () => ({ data: [] }) } }
          : Reflect.get(target, key),
    }),
  };
});
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: false, pauseTour: vi.fn(), activeTour: null }),
}));

import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { useMusicPlayerStore } from '~/store/music-player.store';

const song = (id: number, title: string, durationSec = 200): MusicTrack => ({
  id,
  url: `song-${id}`,
  title,
  durationSec,
  creator: { id: 100 + id, username: `artist${id}` },
});
const nowPlaying = song(1, 'Midnight Arcade');
const palm = song(2, 'Palm Static');
const chrome = song(3, 'Chrome Heart');
const rain = song(4, 'Rain on Shibuya');

const player = () => useMusicPlayerStore.getState();
const titles = (tracks: MusicTrack[]) => tracks.map((t) => t.title);
const panel = () => page.getByRole('region', { name: 'Up next' });
const inPanel = (name: string) => panel().getByRole('button', { name, exact: true });
const onBar = (name: string) =>
  page.getByRole('region', { name: 'Music player' }).getByRole('button', { name, exact: true });

async function openPanel() {
  await renderWithProviders(
    <>
      <p>Page content</p>
      <MusicPlayerBar />
    </>
  );
  await onBar('Up next').click();
  await expect.element(panel()).toBeInTheDocument();
}

beforeEach(async () => {
  await page.viewport(1440, 800);
  player().close();
  if (player().shuffle) player().toggleShuffle();
  while (player().repeat !== 'off') player().cycleRepeat();
});

describe('the Up next panel', () => {
  test('opens from the bar and closes by the button, Escape and an outside click', async () => {
    player().playTrack(nowPlaying);
    await openPanel();
    await expect.element(onBar('Up next')).toHaveAttribute('aria-expanded', 'true');

    await onBar('Up next').click();
    await expect.element(panel()).not.toBeInTheDocument();

    await onBar('Up next').click();
    await expect.element(panel()).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect.element(panel()).not.toBeInTheDocument();

    await onBar('Up next').click();
    await expect.element(panel()).toBeInTheDocument();
    // Inside the panel keeps it open; outside closes it.
    await panel().getByText('Up next', { exact: true }).click();
    await expect.element(panel()).toBeInTheDocument();
    await page.getByText('Page content').click();
    await expect.element(panel()).not.toBeInTheDocument();
  });

  test('lists Queued by you above the rest of the list, with the count and length', async () => {
    player().playTrack(nowPlaying, {
      list: { name: 'Night Drive', tracks: [nowPlaying, palm, chrome] },
    });
    player().addToUpNext(rain);
    await openPanel();

    await expect.element(panel().getByText('3 songs · 10 min')).toBeInTheDocument();
    await expect.element(panel().getByText('QUEUED BY YOU')).toBeInTheDocument();
    await expect.element(panel().getByText('NEXT FROM NIGHT DRIVE')).toBeInTheDocument();
    const rows = panel()
      .getByRole('button', { name: /^Play / })
      .elements()
      .map((el) => el.textContent);
    expect(rows.map((text) => text?.replace(/artist.*/, ''))).toEqual([
      'Rain on Shibuya',
      'Palm Static',
      'Chrome Heart',
    ]);
  });

  test('counts one song in the singular and says so when nothing is queued', async () => {
    player().playTrack(nowPlaying);
    await openPanel();
    await expect
      .element(panel().getByText('Nothing queued. Add songs with Add to up next.'))
      .toBeInTheDocument();
    await expect.element(panel().getByText('0 songs')).toBeInTheDocument();

    player().addToUpNext(palm);
    await expect.element(panel().getByText('1 song · 3 min')).toBeInTheDocument();
    expect(panel().getByText('Nothing queued', { exact: false }).elements()).toHaveLength(0);
  });

  test('a row plays now; its remove button takes it out of Up next', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm, chrome] } });
    await openPanel();

    await inPanel('Remove Palm Static from up next').click();
    expect(titles(player().list)).toEqual(['Chrome Heart']);

    await inPanel('Play Chrome Heart').click();
    expect(player().current?.title).toBe('Chrome Heart');
    expect(player().list).toEqual([]);
  });

  test('Clear empties Up next and leaves the song playing', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    player().addToUpNext(rain);
    await openPanel();

    await inPanel('Clear').click();
    expect(player().queued).toEqual([]);
    expect(player().list).toEqual([]);
    expect(player().playing).toBe(true);
  });

  test('a song played on its own back in the list shows under a label without a list name', async () => {
    player().playTrack(palm);
    player().playTrack(nowPlaying);
    // Previous puts the current song back into the list section, which has no name.
    player().previous();
    await openPanel();
    await expect.element(panel().getByText('NEXT IN LINE')).toBeInTheDocument();
  });

  test('reorders a row from the keyboard', async () => {
    player().playTrack(nowPlaying, {
      list: { name: 'Post', tracks: [nowPlaying, palm, chrome, rain] },
    });
    await openPanel();

    (inPanel('Reorder Rain on Shibuya').element() as HTMLElement).focus();
    await userEvent.keyboard('{Space}');
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Space}');
    await vi.waitFor(() =>
      expect(titles(player().list)).toEqual(['Palm Static', 'Rain on Shibuya', 'Chrome Heart'])
    );
  });

  test('shuffle and repeat show the same state on the bar and in the panel header', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm, chrome] } });
    await openPanel();

    await inPanel('Shuffle').click();
    expect(player().shuffle).toBe(true);
    await expect.element(onBar('Shuffle')).toHaveAttribute('aria-pressed', 'true');
    await expect.element(inPanel('Shuffle')).toHaveAttribute('aria-pressed', 'true');

    await onBar('Repeat').click();
    expect(player().repeat).toBe('all');
    await expect.element(inPanel('Repeat')).toHaveAttribute('aria-pressed', 'true');
    await onBar('Repeat').click();
    await onBar('Repeat').click();
    await expect.element(inPanel('Repeat')).toHaveAttribute('aria-pressed', 'false');
  });
});
