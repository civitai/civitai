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

import {
  songCovers,
  songDetails,
  timedComments,
} from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { SignedOutSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
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

  test("the cover and title open the song's detail; the creator opens their music tab", async () => {
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
      .toHaveAttribute('href', '/user/neonwave/music');
  });

  test('shows no playing animation beside the song name', async () => {
    await renderWithProviders(<MusicPlayerBar />);
    const title = page.getByRole('link', { name: 'Midnight Arcade' }).last();
    await expect.element(title).toBeInTheDocument();
    expect(player().playing).toBe(true);
    expect(title.element().parentElement!.querySelector('[aria-hidden]')).toBeNull();
  });

  for (const scheme of ['light', 'dark'])
    test(`its times read at WCAG AA in ${scheme} mode`, async () => {
      await renderWithProviders(<MusicPlayerBar />);
      await expect.element(page.getByText('3:32')).toBeInTheDocument();
      // After the render: the provider sets the scheme on mount.
      document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
      try {
        const rgb = (css: string) =>
          css
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const lum = (c: number[]) =>
          c
            .map((v) => v / 255)
            .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const surface = lum(rgb(getComputedStyle(bar()).backgroundColor));
        for (const time of ['1:24', '3:32']) {
          const text = lum(rgb(getComputedStyle(page.getByText(time).element()).color));
          const ratio = (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
          expect(ratio, time).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        document.documentElement.removeAttribute('data-mantine-color-scheme');
      }
    });

  for (const scheme of ['light', 'dark'])
    for (const withCover of [true, false])
      test(`its active toggles read at WCAG AA in ${scheme} mode, ${
        withCover ? "in a cover's accent" : 'in the primary'
      }`, async () => {
        songCovers.served = withCover ? [coverRated(1)] : [];
        // The end colours at once, without the toggles' fade.
        const noFade = document.head.appendChild(document.createElement('style'));
        noFade.textContent = '* { transition: none !important; }';
        await renderWithProviders(<MusicPlayerBar />);
        await expect.element(button('Pause')).toBeInTheDocument();
        if (withCover)
          await expect
            .poll(() => bar().style.getPropertyValue('--music-accent'))
            .toMatch(/^#[0-9a-f]{6}$/);
        useMusicPlayerStore.setState({ showTimedComments: true });
        await button('Up next').click();
        await expect.element(page.getByRole('region', { name: 'Up next' })).toBeInTheDocument();
        await expect.element(button('Hide timed comments')).toHaveAttribute('aria-pressed', 'true');
        // After the render: the provider sets the scheme on mount.
        document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
        try {
          /** `[r, g, b, alpha]` (0..255, 0..1) of a computed `rgb()`, `rgba()` or `color(srgb …)`. */
          const parse = (css: string) => {
            const [r, g, b, a = 1] = css.match(/[\d.]+/g)!.map(Number);
            return css.startsWith('color(')
              ? [r * 255, g * 255, b * 255, a]
              : [r, g, b, css.startsWith('rgba') ? a : 1];
          };
          const lum = (c: number[]) =>
            c
              .slice(0, 3)
              .map((v) => v / 255)
              .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const surface = parse(getComputedStyle(bar()).backgroundColor);
          for (const name of ['Hide timed comments', 'Up next']) {
            const toggle = button(name).element();
            const [r, g, b, a] = parse(getComputedStyle(toggle).backgroundColor);
            // The toggle's tint over the bar, as the eye sees it.
            const background = [r, g, b].map((c, i) => c * a + surface[i] * (1 - a));
            expect(a, `${name} is tinted`).toBeGreaterThan(0);
            const text = lum(parse(getComputedStyle(toggle).color));
            const ground = lum(background);
            const ratio = (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
            expect(ratio, name).toBeGreaterThanOrEqual(4.5);
          }
        } finally {
          document.documentElement.removeAttribute('data-mantine-color-scheme');
          noFade.remove();
        }
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

    test('starts again when the bar mounts again over a song already listened to', async () => {
      const first = await renderWithProviders(<MusicPlayerBar />);
      listen(1.2);
      await expect.poll(() => songRequests(fetch)).toHaveLength(1);
      await first.unmount();
      await renderWithProviders(<MusicPlayerBar />);
      await expect.poll(() => songRequests(fetch)).toHaveLength(2);
    });

    // After a page load the last song comes back paused where it was, with nothing played yet in
    // this page: it was listened to before, so its waveform is drawn, not a flat line (S18).
    test('starts for a song restored after a page load, while it is still paused', async () => {
      act(() => player().close());
      act(() => player().restore({ track: { ...song, url: songUrl }, positionSec: 84 }));
      expect(player().playing).toBe(false);
      expect(player().playback?.listenedSec).toBe(0);
      await renderWithProviders(<MusicPlayerBar />);
      await expect.poll(() => songRequests(fetch)).toHaveLength(1);
    });

    test('never starts on the phone bar', async () => {
      await page.viewport(390, 800);
      await renderWithProviders(<MusicPlayerBar />);
      listen(30);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(songRequests(fetch)).toHaveLength(0);
    });
  });

  test('saves the playing song to a playlist', async () => {
    await renderWithProviders(<MusicPlayerBar />);

    await button('Save').click();
    expect(mocks.openAddToCollectionModal).toHaveBeenCalledWith({
      props: { imageId: SONG_ID, type: 'Music' },
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

describe('on a phone', () => {
  // The app's session wraps the player; the sheet reads it for the like.
  const renderPhone = () =>
    renderWithProviders(
      <SignedOutSessionProvider>
        <MusicPlayerBar />
      </SignedOutSessionProvider>
    );
  const sheet = () => page.getByRole('dialog', { name: 'Now playing' });
  const inSheet = (name: string) => sheet().getByRole('button', { name, exact: true });
  const openSheet = async () => {
    await button('Open now playing').click();
    await expect.element(sheet()).toBeVisible();
  };
  const timedComment = {
    id: 9,
    timestampSec: 82,
    text: 'that bass drop',
    user: { id: 109, username: 'mira', image: null, profilePicture: null },
  };

  beforeEach(async () => {
    await page.viewport(390, 800);
    timedComments.reset();
    songDetails.reset();
  });

  test('the mini bar shows the cover, song, comments and play/pause, and no timed comments', async () => {
    timedComments.served = { [SONG_ID]: [timedComment] };
    await renderPhone();
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(page.getByText('neonwave')).toBeInTheDocument();
    await expect.element(page.getByTestId('music-cover-placeholder')).toBeInTheDocument();
    const region = page.getByRole('region', { name: 'Music player' });
    const names = region
      .getByRole('button')
      .elements()
      .map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['Open now playing', 'Pause']);
    await expect
      .element(region.getByRole('link', { name: 'Comments' }))
      .toHaveAttribute('href', expect.stringContaining(`/images/${SONG_ID}`));
    expect(page.getByRole('slider').elements()).toHaveLength(0);
    expect(document.querySelector('[data-testid="timed-comment-strip"]')).toBeNull();
    expect(document.querySelector('[data-testid="timed-comment-label"]')).toBeNull();
    expect(bar().getBoundingClientRect().height).toBe(62);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test('tapping the song opens the now-playing sheet; play/pause and comments do not', async () => {
    await renderPhone();
    await button('Pause').click();
    expect(player().playing).toBe(false);
    // The comments link would navigate; only whether the tap reaches the bar matters here.
    const comments = page
      .getByRole('region', { name: 'Music player' })
      .getByRole('link', { name: 'Comments' })
      .element();
    comments.addEventListener('click', (e) => e.preventDefault(), { once: true });
    await page
      .getByRole('region', { name: 'Music player' })
      .getByRole('link', { name: 'Comments' })
      .click();
    // Long enough for a sheet the taps had opened to start showing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(page.getByRole('dialog').elements()).toHaveLength(0);

    await openSheet();
    // It covers the window, mini bar included.
    const box = sheet().element().getBoundingClientRect();
    expect(box.height).toBeCloseTo(800, 0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test('the sheet shows the song, the list it plays from, and a transport that drives the player', async () => {
    const palm = { ...song, id: 3, title: 'Palm Static' };
    player().playTrack(song, { list: { name: 'Synthwave mix', tracks: [song, palm] } });
    await renderPhone();
    await openSheet();

    await expect.element(sheet().getByText('Playing from Synthwave mix')).toBeVisible();
    await expect.element(sheet().getByRole('heading', { name: 'Midnight Arcade' })).toBeVisible();
    await expect
      .element(sheet().getByRole('link', { name: 'neonwave' }))
      .toHaveAttribute('href', '/user/neonwave/music');
    await expect
      .element(sheet().getByRole('slider', { name: 'Song progress' }))
      .toHaveAttribute('aria-valuetext', '1:24 of 3:32');

    await inSheet('Shuffle').click();
    expect(player().shuffle).toBe(true);
    await inSheet('Shuffle').click();
    await inSheet('Repeat').click();
    expect(player().repeat).toBe('all');
    await inSheet('Repeat').click();
    expect(player().repeat).toBe('one');
    await inSheet('Repeat').click();
    expect(player().repeat).toBe('off');
    await inSheet('Pause').click();
    expect(player().playing).toBe(false);
    await inSheet('Next').click();
    expect(player().current?.title).toBe('Palm Static');
    await expect.element(sheet().getByRole('heading', { name: 'Palm Static' })).toBeVisible();
  });

  test('closes by its chevron, Escape and a downward swipe, leaving the song playing', async () => {
    await renderPhone();

    await openSheet();
    await inSheet('Collapse').click();
    await expect.element(sheet()).not.toBeInTheDocument();

    await openSheet();
    await userEvent.keyboard('{Escape}');
    await expect.element(sheet()).not.toBeInTheDocument();

    await openSheet();
    const grab = sheet().getByTestId('now-playing-grab').element();
    const { left, top } = grab.getBoundingClientRect();
    const pointer = (type: string, y: number) =>
      grab.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: left + 20,
          clientY: y,
        })
      );
    pointer('pointerdown', top + 4);
    pointer('pointermove', top + 60);
    pointer('pointermove', top + 160);
    pointer('pointerup', top + 160);
    await expect.element(sheet()).not.toBeInTheDocument();

    expect(player().current?.id).toBe(SONG_ID);
    expect(player().playing).toBe(true);
  });

  test('a short drag does not close it', async () => {
    await renderPhone();
    await openSheet();
    const grab = sheet().getByTestId('now-playing-grab').element();
    const { left, top } = grab.getBoundingClientRect();
    for (const [type, y] of [
      ['pointerdown', top + 4],
      ['pointermove', top + 30],
      ['pointerup', top + 30],
    ] as const)
      grab.dispatchEvent(
        new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: left + 20, clientY: y })
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(sheet()).toBeVisible();
  });

  test('closes the player from the sheet', async () => {
    await renderPhone();
    await openSheet();
    await inSheet('Close player').click();
    expect(player().current).toBeNull();
    await expect.element(sheet()).not.toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  test('the sheet shows the lines around the playhead, the current one set apart', async () => {
    songDetails.lyrics = {
      [SONG_ID]: [
        { t: null, text: '[Verse 1]' },
        { t: 60_000, text: 'Every high score' },
        { t: 80_000, text: 'Joystick heartbeat' },
        { t: 90_000, text: 'Player two' },
        { t: 100_000, text: 'Game over' },
      ],
    };
    await renderPhone();
    await openSheet();

    const lyrics = sheet().getByTestId('now-playing-lyrics');
    await expect.element(lyrics).toBeVisible();
    const lines = [...lyrics.element().querySelectorAll('p')];
    expect(lines.map((p) => p.textContent)).toEqual([
      'Every high score',
      'Joystick heartbeat',
      'Player two',
    ]);
    const [past, current, next] = lines.map((p) => getComputedStyle(p));
    expect(lines[1].getAttribute('aria-current')).toBe('true');
    expect(current.color).not.toBe(past.color);
    expect(current.color).not.toBe(next.color);
    expect(parseFloat(current.fontSize)).toBeGreaterThan(parseFloat(next.fontSize));
  });

  test('the sheet shows no lyrics block for a song without timed lyrics', async () => {
    songDetails.lyrics = { [SONG_ID]: [{ t: null, text: 'Plain words' }] };
    await renderPhone();
    await openSheet();
    expect(document.querySelector('[data-testid="now-playing-lyrics"]')).toBeNull();
  });

  test('the bottom row counts the song’s comments, which open the song, beside the like and Up next', async () => {
    songDetails.images = {
      [SONG_ID]: {
        id: SONG_ID,
        url: 'song-key',
        type: 'audio',
        nsfwLevel: 1,
        // Nothing to remix: the Remix menu's own tests cover it.
        hasMeta: false,
        stats: { commentCountAllTime: 56 },
        reactions: [],
        user: { id: 2, username: 'neonwave' },
      },
    };
    await renderPhone();
    await openSheet();
    await expect
      .element(sheet().getByRole('link', { name: '56 comments' }))
      .toHaveAttribute('href', expect.stringContaining(`/images/${SONG_ID}`));
    await expect.element(inSheet('Up next')).toBeVisible();
    // Signed out: shown, but it cannot be pressed.
    await expect.element(inSheet('Like')).toBeDisabled();
    await expect.element(inSheet('Remix this')).not.toBeInTheDocument();
  });

  test('spare height around the cover splits above and below it, not pooled under it', async () => {
    await page.viewport(390, 844);
    await renderPhone();
    await openSheet();
    const art = sheet().getByTestId('music-cover-placeholder').element().getBoundingClientRect();
    const grab = sheet().getByTestId('now-playing-grab').element().getBoundingClientRect();
    const title = sheet()
      .getByRole('heading', { name: 'Midnight Arcade' })
      .element()
      .getBoundingClientRect();
    const above = art.top - grab.bottom;
    const below = title.top - art.bottom;
    expect(Math.abs(below - above)).toBeLessThanOrEqual(4);
  });
});
