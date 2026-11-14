// The real cascade, so the bar lays out (and the waveform has a width to seek across) as it does on
// the site.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { Modal } from '@mantine/core';
import { encode } from 'blurhash';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as MusicPlayerAudioModule from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { PlayerSongCover } from '~/server/services/post.service';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  browsingLevel: 1,
  openAddToCollectionModal: vi.fn(),
  seekMusicPlayer: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('./__tests__/song-covers-trpc-stub');
  return { ...actual, trpc: withSongCoversStub(actual.trpc) };
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

import { songCovers } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { DialogProvider, useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
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
/** The element a pointer at the middle of `el` lands on. */
const hitAt = (el: Element) => {
  const { left, top, width, height } = el.getBoundingClientRect();
  return document.elementFromPoint(left + width / 2, top + height / 2);
};
const bar = () => document.querySelector('[data-music-player-bar]') as HTMLElement;
const button = (name: string) => page.getByRole('button', { name, exact: true });

beforeEach(async () => {
  // The desktop width the bar is drawn for; the phone layout has its own test.
  await page.viewport(1440, 800);
  vi.clearAllMocks();
  songCovers.reset();
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

  test("the cover and title open the song's detail; the creator opens their profile", async () => {
    await renderWithProviders(<MusicPlayerBar />);
    const region = page.getByRole('region', { name: 'Music player' });
    const detailLinks = region
      .getByRole('link')
      .elements()
      .filter((el) => el.getAttribute('href')?.includes(`/images/${SONG_ID}`));
    // The cover, and the title.
    expect(detailLinks).toHaveLength(2);
    expect(detailLinks[1].textContent).toBe('Midnight Arcade');
    await expect
      .element(region.getByRole('link', { name: 'neonwave' }))
      .toHaveAttribute('href', '/user/neonwave');
  });

  test('is slim: 72px tall on desktop', async () => {
    await renderWithProviders(<MusicPlayerBar />);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    expect(bar().getBoundingClientRect().height).toBe(72);
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

  test('the small icon buttons light up on hover like the 36px ones', async () => {
    // The end colour at once, without the fade.
    const noFade = document.head.appendChild(document.createElement('style'));
    noFade.textContent = '* { transition: none !important; }';
    try {
      await renderWithProviders(<MusicPlayerBar />);
      const background = (el: Element) => getComputedStyle(el).backgroundColor;

      await userEvent.hover(button('Save'));
      const hovered = background(button('Save').element());
      expect(hovered).not.toBe('rgba(0, 0, 0, 0)');

      for (const name of ['Shuffle', 'Previous', 'Next', 'Repeat', 'Mute']) {
        expect(background(button(name).element())).toBe('rgba(0, 0, 0, 0)');
        await userEvent.hover(button(name));
        expect(background(button(name).element())).toBe(hovered);
      }
    } finally {
      noFade.remove();
    }
  });

  test('play/pause names itself in a tooltip shown over the bar', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await userEvent.hover(button('Pause'));
    const tooltip = page.getByRole('tooltip', { name: 'Pause' });
    await expect.element(tooltip).toBeVisible();
    // Tooltips let the pointer through; take it for the hit test, to see what is on top.
    (tooltip.element() as HTMLElement).style.pointerEvents = 'auto';
    expect(tooltip.element().contains(hitAt(tooltip.element()))).toBe(true);
  });

  test('mutes and unmutes from the volume icon', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Mute').click();
    expect(player().muted).toBe(true);
    await button('Unmute').click();
    expect(player().muted).toBe(false);
  });

  test('takes its accent from a shown cover and carries none without one', async () => {
    songCovers.served = [coverRated(1)];
    const { rerender } = await renderWithProviders(<MusicPlayerBar />);
    await expect.element(button('Pause')).toBeInTheDocument();
    expect(bar().style.getPropertyValue('--music-accent')).toMatch(/^#[0-9a-f]{6}$/);

    songCovers.served = [];
    await rerender(<MusicPlayerBar />);
    expect(bar().style.getPropertyValue('--music-accent')).toBe('');
  });

  test('shows the placeholder and no accent for a cover above the browsing level', async () => {
    songCovers.served = [coverRated(4)];
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

  test('stays above an open dialog: never dimmed, and its controls and Up next still work', async () => {
    function Lightbox() {
      const dialog = useDialogContext();
      return (
        <Modal {...dialog} title="Lightbox">
          Image
        </Modal>
      );
    }
    dialogStore.closeAll();
    await renderWithProviders(
      <div className="flex h-screen flex-col">
        <main className="flex-1">Page</main>
        <MusicPlayerBar />
        <DialogProvider />
      </div>
    );
    dialogStore.trigger({ component: Lightbox });
    await expect.element(page.getByRole('dialog', { name: 'Lightbox' })).toBeVisible();

    const pause = button('Pause').element();
    expect(pause.contains(hitAt(pause))).toBe(true);
    await button('Pause').click();
    expect(player().playing).toBe(false);

    await button('Up next').click();
    const upNext = page.getByRole('region', { name: 'Up next' }).element();
    expect(upNext.contains(hitAt(upNext))).toBe(true);
    dialogStore.closeAll();
  });

  describe('the waveform download', () => {
    // A song no other test decoded: decoded peaks are cached per song for the page's lifetime.
    let songUrl = '';
    let run = 0;
    const songRequests = (fetch: ReturnType<typeof vi.spyOn>) =>
      fetch.mock.calls.filter(([input]: unknown[]) => String(input).includes(songUrl));
    const listen = (listenedSec: number) =>
      act(() =>
        useMusicPlayerStore.setState((s) => ({
          playback: s.playback && { ...s.playback, listenedSec },
        }))
      );
    let fetch: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      songUrl = `waveform-song-${++run}`;
      player().playTrack({ ...song, url: songUrl });
      // Never answers on its own; rejects when aborted.
      fetch = vi
        .spyOn(window, 'fetch')
        .mockImplementation(
          (_, init) =>
            new Promise((_, reject) =>
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError'))
              )
            )
        );
    });
    afterEach(() => fetch.mockRestore());

    test('starts only after the song has played a second, and stops when the song changes', async () => {
      await renderWithProviders(<MusicPlayerBar />);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(songRequests(fetch)).toHaveLength(0);

      listen(1.2);
      await expect.poll(() => songRequests(fetch)).toHaveLength(1);
      const signal = (songRequests(fetch)[0][1] as RequestInit).signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      act(() => player().playTrack({ ...song, id: 7, url: 'other-song' }));
      expect(signal.aborted).toBe(true);
    });

    test('never starts on the phone bar', async () => {
      await page.viewport(390, 800);
      await renderWithProviders(<MusicPlayerBar />);
      listen(30);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(songRequests(fetch)).toHaveLength(0);
    });
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

  test('below the sm breakpoint shows only the cover, song, play/pause and close', async () => {
    await page.viewport(390, 800);
    await renderWithProviders(<MusicPlayerBar />);
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(page.getByText('neonwave')).toBeInTheDocument();
    await expect.element(page.getByTestId('music-cover-placeholder')).toBeInTheDocument();
    const names = page
      .getByRole('region', { name: 'Music player' })
      .getByRole('button')
      .elements()
      .map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['Pause', 'Close player']);
    expect(page.getByRole('slider').elements()).toHaveLength(0);
    expect(bar().getBoundingClientRect().height).toBe(62);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);

    await button('Pause').click();
    expect(player().playing).toBe(false);
    await button('Close player').click();
    expect(player().current).toBeNull();
  });
});
