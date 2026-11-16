// The real cascade, so the strip lays out across the waveform's width as it does on the site.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { act } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as MusicPlayerAudioModule from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { PlayerTimedComment } from '~/components/MusicPlayer/MusicPlayerTimedComments';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

const seekMusicPlayer = vi.hoisted(() => vi.fn());
const triggerRoutedDialog = vi.hoisted(() => vi.fn());

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('./__tests__/song-covers-trpc-stub');
  return { ...actual, trpc: withSongCoversStub(actual.trpc) };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: false, pauseTour: vi.fn(), activeTour: null }),
}));
vi.mock('~/components/MusicPlayer/MusicPlayerAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof MusicPlayerAudioModule>()),
  seekMusicPlayer,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  triggerRoutedDialog,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span data-avatar={user.username} />,
}));

import { timedComments } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const SONG_ID = 1;
const DURATION = 200;
const song: MusicTrack = {
  id: SONG_ID,
  url: 'song-key',
  title: 'Midnight Arcade',
  durationSec: DURATION,
  creator: { id: 2, username: 'neonwave' },
};
const timed = (id: number, timestampSec: number, username: string, text: string) =>
  ({
    id,
    timestampSec,
    text,
    user: { id: 100 + id, username, image: null, profilePicture: null },
  } satisfies PlayerTimedComment);

const player = () => useMusicPlayerStore.getState();
// The bar at the window's bottom edge, as the last row of the site's column.
const renderBar = () =>
  renderWithProviders(
    <div className="flex h-screen flex-col">
      <div className="flex-1" />
      <MusicPlayerBar />
    </div>
  );
const strip = () => document.querySelector('[data-testid="timed-comment-strip"]');
const labels = () =>
  [...document.querySelectorAll('[data-testid="timed-comment-label"]')].map((l) => l.textContent);
const avatar = (id: number) =>
  document.querySelector(`[data-timed-comment="${id}"]`) as HTMLElement;
const cluster = (firstId: number) =>
  document.querySelector(`[data-timed-cluster="${firstId}"]`) as HTMLElement;
const label = () => document.querySelector('[data-testid="timed-comment-label"]') as HTMLElement;
const bar = () => document.querySelector('[data-music-player-bar]')!.getBoundingClientRect();
const openedDetail = (commentId: number) =>
  expect(triggerRoutedDialog).toHaveBeenCalledWith({
    name: 'imageDetail',
    state: { imageId: SONG_ID, highlight: commentId },
  });
const at = (currentTime: number) =>
  act(() => useMusicPlayheadStore.setState({ currentTime, duration: DURATION }));

beforeEach(async () => {
  await page.viewport(1440, 800);
  vi.clearAllMocks();
  timedComments.reset();
  timedComments.served[SONG_ID] = [
    timed(1, 50, 'mira', 'that bass drop'),
    timed(2, 52, 'kat', 'here it comes'),
    timed(3, 150, 'jo', 'the outro'),
  ];
  window.isAuthed = true;
  if (!player().showTimedComments) player().toggleTimedComments();
  player().close();
  player().playTrack(song);
  useMusicPlayheadStore.setState({ currentTime: 10, duration: DURATION });
});

describe('timed comments on the bar’s waveform', () => {
  test('sit above the waveform at their times', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    const box = strip()!.getBoundingClientRect();
    const centre = (id: number) => {
      const r = avatar(id).getBoundingClientRect();
      return (r.left + r.width / 2 - box.left) / box.width;
    };
    // 1 and 2 are two seconds apart: one stack, its first avatar at the first one's time.
    const first = cluster(1).querySelector('[data-avatar]')!.parentElement!.getBoundingClientRect();
    expect((first.left + first.width / 2 - box.left) / box.width).toBeCloseTo(0.25, 2);
    expect(centre(3)).toBeCloseTo(0.75, 2);
    const slider = document.querySelector('[role="slider"]')!.getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(slider.top + 1);
  });

  test('show one label at a time, for 4 s from its time', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    expect(labels()).toEqual([]);
    await at(151);
    await expect.poll(labels).toEqual(['jo  the outro']);
    await at(154.5);
    await expect.poll(labels).toEqual([]);
  });

  test('a click on an avatar seeks there and opens the song with that comment highlighted', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await userEvent.click(avatar(3));
    expect(seekMusicPlayer).toHaveBeenCalledWith(150);
    openedDetail(3);
  });

  test('the toggle hides them without moving the waveform; it shows them again', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    const waveformTop = () => document.querySelector('[role="slider"]')!.getBoundingClientRect().top;
    const topBefore = waveformTop();
    const hide = page.getByRole('button', { name: 'Hide timed comments', exact: true });
    await expect.element(hide).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hide);
    await expect.poll(strip).toBeNull();
    expect(player().showTimedComments).toBe(false);
    expect(waveformTop()).toBe(topBefore);
    await at(151);
    expect(labels()).toEqual([]);

    const show = page.getByRole('button', { name: 'Show timed comments', exact: true });
    await expect.element(show).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(show);
    await expect.poll(() => avatar(3)).toBeTruthy();
  });

  test('leave the waveform as it was on a song without any', async () => {
    timedComments.served[SONG_ID] = [];
    await renderBar();
    await expect.element(page.getByRole('slider', { name: 'Song progress' })).toBeInTheDocument();
    expect(strip()).toBeNull();
    expect(document.querySelector('[role="slider"]')!.getBoundingClientRect().height).toBe(48);
  });
});

describe('the floating label', () => {
  test('floats above the bar, at its avatar', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await at(151);
    await expect.poll(label).toBeTruthy();
    const box = label().getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(bar().top);
    const anchor = avatar(3).getBoundingClientRect();
    // The label's own 18px avatar (after 3px of padding) sits over the strip's.
    expect(box.left + 12).toBeCloseTo(anchor.left + anchor.width / 2, 0);
  });

  test('stays inside the window at the end of the song', async () => {
    timedComments.served[SONG_ID] = [
      timed(9, 199, 'mira', 'a long last word on the song that runs past the edge of the window'),
    ];
    await renderBar();
    await expect.poll(() => avatar(9)).toBeTruthy();
    await at(199.5);
    await expect.poll(label).toBeTruthy();
    const box = label().getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(box.bottom).toBeLessThanOrEqual(bar().top);
  });

  test('a click opens the song with that comment highlighted', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await at(151);
    await expect.poll(label).toBeTruthy();
    await userEvent.click(label());
    openedDetail(3);
    expect(seekMusicPlayer).not.toHaveBeenCalled();
  });
});

describe('a cluster of nearby comments', () => {
  beforeEach(() => {
    timedComments.served[SONG_ID] = [
      timed(1, 50, 'mira', 'that bass drop'),
      timed(2, 51, 'kat', 'here it comes'),
      timed(4, 52, 'jun', 'on loop'),
      timed(5, 53, 'kai', 'who made the synth?'),
      timed(6, 54, 'ada', 'wow'),
      timed(3, 150, 'jo', 'the outro'),
    ];
  });

  test('is one stack of three avatars and a count of the rest', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    expect(cluster(1).querySelectorAll('[data-avatar]')).toHaveLength(3);
    expect(cluster(1).textContent).toBe('+2');
    expect(avatar(2)).toBeNull();
    expect(avatar(3)).toBeTruthy();
  });

  test('hovering it lists its comments; a row opens the song at that comment', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    await userEvent.hover(cluster(1));
    const list = page.getByRole('dialog', { name: 'Comments around 0:50' });
    await expect.element(list).toBeInTheDocument();
    await expect.element(list.getByText('5 total')).toBeInTheDocument();
    expect(list.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(bar().top);
    const row = list.getByRole('button', { name: /kai/ });
    await expect.element(row).toHaveTextContent('kai0:53who made the synth?');
    await userEvent.click(row);
    openedDetail(5);
  });

  test('focusing it lists its comments too', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    cluster(1).focus();
    await expect
      .element(page.getByRole('dialog', { name: 'Comments around 0:50' }))
      .toBeInTheDocument();
  });

  test('reaching it shows its comments one after another', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    await at(50.5);
    await expect.poll(labels).toEqual(['mira  that bass drop']);
    await at(54.5);
    await expect.poll(labels).toEqual(['kat  here it comes']);
    await at(58.5);
    await expect.poll(labels).toEqual(['jun  on loop']);
  });
});
