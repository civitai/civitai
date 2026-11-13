import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ getImage: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('./__tests__/song-covers-trpc-stub');
  return {
    ...actual,
    trpc: withSongCoversStub(actual.trpc),
    trpcVanilla: { image: { get: { query: mocks.getImage } } },
  };
});

import { MusicPlayerSlot } from '~/components/MusicPlayer/MusicPlayerSlot';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { MUSIC_PLAYER_RESUME_KEY } from '~/store/music-player-resume';

const song: MusicTrack = {
  id: 1,
  url: 'song-key',
  title: 'Midnight Arcade',
  durationSec: 200,
  creator: { id: 2, username: 'neonwave' },
};

const player = () => useMusicPlayerStore.getState();
const audios = () => document.querySelectorAll('audio');
const bar = () => document.querySelector('[data-music-player-bar]');
// The player's code is a separate chunk: the first load in a fresh test browser can take seconds.
const mounted = () => vi.waitFor(() => expect(audios()).toHaveLength(1), { timeout: 10_000 });

beforeEach(() => {
  player().close();
  localStorage.removeItem(MUSIC_PLAYER_RESUME_KEY);
  mocks.getImage.mockReset();
  // No audio loads in the test browser; a refused play must not end the test's playback state.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

describe('the music player slot in the site chrome', () => {
  test('renders nothing, not even the audio element, with the music flag off', async () => {
    player().playTrack(song);
    await renderWithProviders(<MusicPlayerSlot enabled={false} />);
    expect(audios()).toHaveLength(0);
    expect(bar()).toBeNull();
  });

  test('with the flag on, holds the one audio element and shows the bar only for an active song', async () => {
    await renderWithProviders(<MusicPlayerSlot enabled />);
    await mounted();
    expect(bar()).toBeNull();

    player().playTrack(song);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    expect(bar()).not.toBeNull();
    expect(audios()).toHaveLength(1);
  });

  test('closes an active player when the flag turns off', async () => {
    const { rerender } = await renderWithProviders(<MusicPlayerSlot enabled />);
    await mounted();
    player().playTrack(song);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();

    await rerender(<MusicPlayerSlot enabled={false} />);
    expect(player().current).toBeNull();
    expect(player().view).toBe('closed');
    expect(audios()).toHaveLength(0);
  });

  test('after a reload, brings the last song back paused at its position', async () => {
    localStorage.setItem(MUSIC_PLAYER_RESUME_KEY, JSON.stringify({ track: song, positionSec: 30 }));
    mocks.getImage.mockResolvedValue({
      id: 1,
      type: 'audio',
      url: 'song-key',
      metadata: { title: 'Midnight Arcade', duration: 200 },
      user: { id: 2, username: 'neonwave' },
    });
    await renderWithProviders(<MusicPlayerSlot enabled />);
    await mounted();

    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    expect(mocks.getImage).toHaveBeenCalledWith({ id: 1 });
    expect(player().playing).toBe(false);
    expect(audios()[0].currentTime).toBe(30);
    expect(audios()[0].paused).toBe(true);

    player().close();
    expect(localStorage.getItem(MUSIC_PLAYER_RESUME_KEY)).toBeNull();
  });

  test('with the flag off, the saved song is neither read nor restored', async () => {
    localStorage.setItem(MUSIC_PLAYER_RESUME_KEY, JSON.stringify({ track: song, positionSec: 30 }));
    await renderWithProviders(<MusicPlayerSlot enabled={false} />);
    expect(mocks.getImage).not.toHaveBeenCalled();
    expect(player().current).toBeNull();
    expect(localStorage.getItem(MUSIC_PLAYER_RESUME_KEY)).not.toBeNull();
  });
});
