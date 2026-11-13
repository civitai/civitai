// The real cascade, so the bar lays out (and the waveform has a width to seek across) as it does on
// the site.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { encode } from 'blurhash';
import { act } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as MusicPlayerAudioModule from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { PlayerSongCover } from '~/server/services/post.service';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  covers: [] as PlayerSongCover[],
  browsingLevel: 1,
  openAddToCollectionModal: vi.fn(),
  seekMusicPlayer: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: new Proxy(actual.trpc, {
      get: (target, key) =>
        key === 'image'
          ? { getSongCovers: { useQuery: () => ({ data: mocks.covers }) } }
          : Reflect.get(target, key),
    }),
  };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => mocks.browsingLevel,
}));
vi.mock('~/components/Dialog/triggers/add-to-collection', () => ({
  openAddToCollectionModal: mocks.openAddToCollectionModal,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: false, pauseTour: vi.fn(), activeTour: null }),
}));
vi.mock('~/components/MusicPlayer/MusicPlayerAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof MusicPlayerAudioModule>()),
  seekMusicPlayer: mocks.seekMusicPlayer,
}));

import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const SONG_ID = 1;
const song: MusicTrack = {
  id: SONG_ID,
  url: 'song-key',
  title: 'Midnight Arcade',
  durationSec: 212,
  creator: { id: 2, username: 'neonwave' },
};

function flatHash(r: number, g: number, b: number) {
  const pixels = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) pixels.set([r, g, b, 255], i * 4);
  return encode(pixels, 4, 4, 4, 3);
}
const coverRated = (nsfwLevel: number): PlayerSongCover => ({
  songId: SONG_ID,
  id: 50,
  url: LOADABLE_IMAGE_DATA_URI,
  hash: flatHash(0xe6, 0x49, 0x80),
  nsfwLevel,
});

const player = () => useMusicPlayerStore.getState();
const bar = () => document.querySelector('[data-music-player-bar]') as HTMLElement;
const button = (name: string) => page.getByRole('button', { name, exact: true });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.covers = [];
  mocks.browsingLevel = 1;
  window.isAuthed = true;
  player().close();
  player().playTrack(song);
  useMusicPlayheadStore.setState({ currentTime: 84, duration: 212 });
});

describe('the global player bar', () => {
  test('shows every control by name, the song, and the time as m:ss', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    for (const name of [
      'Minimize player',
      'Shuffle',
      'Previous',
      'Pause',
      'Next',
      'Repeat',
      'Save',
      'Up next',
      'Mute',
      'Close player',
    ])
      await expect.element(button(name)).toBeInTheDocument();
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(page.getByText('neonwave')).toBeInTheDocument();
    await expect.element(page.getByText('1:24')).toBeInTheDocument();
    await expect.element(page.getByText('3:32')).toBeInTheDocument();
  });

  test('seeks from the waveform by keyboard and by pointer', async () => {
    // The desktop width the bar is drawn for, so the waveform has room to seek across.
    await page.viewport(1440, 800);
    await renderWithProviders(<MusicPlayerBar />);
    const slider = page.getByRole('slider', { name: 'Song progress' });
    await expect.element(slider).toHaveAttribute('aria-valuetext', '1:24 of 3:32');

    (slider.element() as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(mocks.seekMusicPlayer).toHaveBeenLastCalledWith(89);
    await userEvent.keyboard('{ArrowLeft}');
    expect(mocks.seekMusicPlayer).toHaveBeenLastCalledWith(79);

    const { width, height } = slider.element().getBoundingClientRect();
    await userEvent.click(slider, { position: { x: width / 2, y: height / 2 } });
    const seekedTo = mocks.seekMusicPlayer.mock.lastCall?.[0] as number;
    expect(seekedTo).toBeGreaterThan(212 * 0.45);
    expect(seekedTo).toBeLessThan(212 * 0.55);
  });

  test('pauses and plays, swapping the glyph', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Pause').click();
    expect(player().playing).toBe(false);
    await expect.element(button('Play')).toBeInTheDocument();

    await button('Play').click();
    expect(player().playing).toBe(true);
    await expect.element(button('Pause')).toBeInTheDocument();
  });

  test('mutes and unmutes from the volume icon', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Mute').click();
    expect(player().muted).toBe(true);
    await button('Unmute').click();
    expect(player().muted).toBe(false);
  });

  test('takes its accent from a shown cover and carries none without one', async () => {
    mocks.covers = [coverRated(1)];
    const { rerender } = await renderWithProviders(<MusicPlayerBar />);
    await expect.element(button('Pause')).toBeInTheDocument();
    expect(bar().style.getPropertyValue('--music-accent')).toMatch(/^#[0-9a-f]{6}$/);

    mocks.covers = [];
    await rerender(<MusicPlayerBar />);
    expect(bar().style.getPropertyValue('--music-accent')).toBe('');
  });

  test('shows the placeholder and no accent for a cover above the browsing level', async () => {
    mocks.covers = [coverRated(4)];
    mocks.browsingLevel = 1;
    const { rerender } = await renderWithProviders(<MusicPlayerBar />);
    await expect.element(page.getByTestId('music-cover-placeholder')).toBeInTheDocument();
    expect(bar().querySelector('img')).toBeNull();
    expect(bar().style.getPropertyValue('--music-accent')).toBe('');

    mocks.browsingLevel = 1 | 4;
    await rerender(<MusicPlayerBar />);
    expect(page.getByTestId('music-cover-placeholder').elements()).toHaveLength(0);
    expect(bar().querySelector('img')).not.toBeNull();
  });

  test('saves the playing song through the image collection flow', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Save').click();
    expect(mocks.openAddToCollectionModal).toHaveBeenCalledWith({
      props: { imageId: SONG_ID, type: 'Image' },
    });
  });

  test('closes the player', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Close player').click();
    expect(player().current).toBeNull();
    expect(bar()).toBeNull();
  });

  test('a song that failed to load stays on the bar, not playing, and can be skipped', async () => {
    player().addToUpNext({ ...song, id: 3, title: 'Palm Static' });
    act(() => player().markError());
    await renderWithProviders(<MusicPlayerBar />);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(button('Play')).toBeInTheDocument();

    await button('Next').click();
    expect(player().current?.title).toBe('Palm Static');
  });
});
