// The real cascade, so the strip lays out across the waveform's width as it does on the site.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { act } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as MusicPlayerAudioModule from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { PlayerTimedComment } from '~/components/MusicPlayer/MusicPlayerTimedComments';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

const seekMusicPlayer = vi.hoisted(() => vi.fn());

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
const strip = () => document.querySelector('[data-testid="timed-comment-strip"]');
const labels = () =>
  [...document.querySelectorAll('[data-testid="timed-comment-label"]')].map((l) => l.textContent);
const avatar = (id: number) =>
  document.querySelector(`[data-timed-comment="${id}"]`) as HTMLElement;
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
    await renderWithProviders(<MusicPlayerBar />);
    await expect.poll(() => avatar(3)).toBeTruthy();
    const box = strip()!.getBoundingClientRect();
    const centre = (id: number) => {
      const r = avatar(id).getBoundingClientRect();
      return (r.left + r.width / 2 - box.left) / box.width;
    };
    expect(centre(1)).toBeCloseTo(0.25, 2);
    expect(centre(3)).toBeCloseTo(0.75, 2);
    const slider = document.querySelector('[role="slider"]')!.getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(slider.top + 1);
  });

  test('show one label at a time: the latest the playhead reached, for 4 s', async () => {
    await renderWithProviders(<MusicPlayerBar />);
    await expect.poll(() => avatar(1)).toBeTruthy();
    expect(labels()).toEqual([]);
    await at(51);
    await expect.poll(labels).toEqual(['mira  that bass drop']);
    await at(53);
    await expect.poll(labels).toEqual(['kat  here it comes']);
    await at(56.5);
    await expect.poll(labels).toEqual([]);
    await at(151);
    await expect.poll(labels).toEqual(['jo  the outro']);
  });

  test('a click on an avatar seeks the player to its time', async () => {
    await renderWithProviders(<MusicPlayerBar />);
    await expect.poll(() => avatar(3)).toBeTruthy();
    await userEvent.click(avatar(3));
    expect(seekMusicPlayer).toHaveBeenCalledWith(150);
  });

  test('the toggle hides them without moving the waveform; it shows them again', async () => {
    await renderWithProviders(<MusicPlayerBar />);
    await expect.poll(() => avatar(1)).toBeTruthy();
    const waveformTop = () => document.querySelector('[role="slider"]')!.getBoundingClientRect().top;
    const topBefore = waveformTop();
    const hide = page.getByRole('button', { name: 'Hide timed comments', exact: true });
    await expect.element(hide).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hide);
    await expect.poll(strip).toBeNull();
    expect(player().showTimedComments).toBe(false);
    expect(waveformTop()).toBe(topBefore);
    await at(51);
    expect(labels()).toEqual([]);

    const show = page.getByRole('button', { name: 'Show timed comments', exact: true });
    await expect.element(show).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(show);
    await expect.poll(() => avatar(1)).toBeTruthy();
  });

  test('leave the waveform as it was on a song without any', async () => {
    timedComments.served[SONG_ID] = [];
    await renderWithProviders(<MusicPlayerBar />);
    await expect.element(page.getByRole('slider', { name: 'Song progress' })).toBeInTheDocument();
    expect(strip()).toBeNull();
    expect(document.querySelector('[role="slider"]')!.getBoundingClientRect().height).toBe(48);
  });
});
