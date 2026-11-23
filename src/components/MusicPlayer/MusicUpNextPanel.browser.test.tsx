import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type { MusicTrack } from '~/store/music-player.store';
import type * as Trpc from '~/utils/trpc';

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

import { SignedOutSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { songCovers } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
import { SongUpNextButton } from '~/components/Music/SongDetail/SongUpNextButton';
import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

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
  songCovers.reset();
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

  test('reads the covers of the playing song and of every song in Up next, once each', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm, chrome] } });
    player().addToUpNext(rain);
    songCovers.served = [
      { songId: rain.id, id: 90, url: LOADABLE_IMAGE_DATA_URI, hash: null, nsfwLevel: 1 },
    ];
    await openPanel();

    const row = panel().getByRole('button', { name: 'Play Rain on Shibuya' });
    await expect.poll(() => row.element().querySelector('img')).not.toBeNull();
    expect(row.getByTestId('music-cover-placeholder').elements()).toHaveLength(0);
    // A song without a cover keeps the placeholder.
    await expect
      .element(
        panel()
          .getByRole('button', { name: 'Play Palm Static' })
          .getByTestId('music-cover-placeholder')
      )
      .toBeInTheDocument();
    expect(songCovers.requests).not.toContain('invalid');
    expect(songCovers.requests).toContainEqual([nowPlaying.id, rain.id, palm.id, chrome.id]);
  });

  test('counts one song in the singular, and says nothing queued only once', async () => {
    player().playTrack(nowPlaying);
    await openPanel();
    await expect
      .element(panel().getByText('Nothing queued. Add songs with Add to up next.'))
      .toBeInTheDocument();
    expect(
      panel()
        .getByText(/\d+ songs?/)
        .elements()
    ).toHaveLength(0);

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

  test('Clear is Civitai blue 3 in dark', async () => {
    player().playTrack(nowPlaying);
    await openPanel();
    const scheme = document.documentElement.getAttribute('data-mantine-color-scheme');
    document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
    try {
      expect(getComputedStyle(inPanel('Clear').element()).color).toBe('rgb(116, 192, 252)');
    } finally {
      if (scheme) document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
      else document.documentElement.removeAttribute('data-mantine-color-scheme');
    }
  });

  for (const scheme of ['light', 'dark'])
    test(`a song's length reads at WCAG AA in ${scheme} mode`, async () => {
      player().playTrack(nowPlaying, { list: { name: 'Feed', tracks: [nowPlaying, rain] } });
      await openPanel();
      const previous = document.documentElement.getAttribute('data-mantine-color-scheme');
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
        const surface = lum(rgb(getComputedStyle(panel().element()).backgroundColor));
        const length = panel().getByText(formatPlaybackTime(rain.durationSec)).first().element();
        const text = lum(rgb(getComputedStyle(length).color));
        expect(
          (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05)
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        if (previous) document.documentElement.setAttribute('data-mantine-color-scheme', previous);
        else document.documentElement.removeAttribute('data-mantine-color-scheme');
      }
    });

  for (const scheme of ['light', 'dark'])
    test(`its Shuffle, Repeat and Clear read at WCAG AA in ${scheme} mode, hovered too`, async () => {
      useMusicPlayerStore.setState({ shuffle: true, repeat: 'all' });
      player().playTrack(nowPlaying, { list: { name: 'Feed', tracks: [nowPlaying, rain] } });
      const previous = document.documentElement.getAttribute('data-mantine-color-scheme');
      try {
        await openPanel();
        document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
        /** `[r, g, b, alpha]` of a computed `rgb()` / `rgba()`. */
        const parse = (css: string) => {
          const [r, g, b, a = 1] = css.match(/[\d.]+/g)!.map(Number);
          return [r, g, b, css.startsWith('rgba') ? a : 1];
        };
        const lum = (c: number[]) =>
          c
            .slice(0, 3)
            .map((v) => v / 255)
            .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const surface = parse(getComputedStyle(panel().element()).backgroundColor);
        // The scheme took effect: white in light, dark-5 in dark.
        if (scheme === 'dark') expect(lum(surface)).toBeLessThan(0.05);
        else expect(lum(surface)).toBeGreaterThan(0.9);
        const ratio = (el: Element) => {
          const [r, g, b, a] = parse(getComputedStyle(el).backgroundColor);
          const ground = lum([r, g, b].map((c, i) => c * a + surface[i] * (1 - a)));
          const text = lum(parse(getComputedStyle(el).color));
          return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
        };
        for (const name of ['Shuffle', 'Repeat', 'Clear']) {
          const control = inPanel(name).element();
          expect(ratio(control), name).toBeGreaterThanOrEqual(4.5);
          await userEvent.hover(control);
          expect(ratio(control), `${name} hovered`).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        if (previous) document.documentElement.setAttribute('data-mantine-color-scheme', previous);
        else document.documentElement.removeAttribute('data-mantine-color-scheme');
        useMusicPlayerStore.setState({ shuffle: false, repeat: 'off' });
      }
    });

  test('the drag handle says what it does in a tooltip over the panel', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm, chrome] } });
    await openPanel();

    await userEvent.hover(inPanel('Reorder Chrome Heart'));
    const tooltip = page.getByRole('tooltip', { name: 'Drag to reorder' });
    await expect.element(tooltip).toBeVisible();
    const el = tooltip.element() as HTMLElement;
    // Tooltips let the pointer through; take it for the hit test, to see what is on top.
    el.style.pointerEvents = 'auto';
    const { left, top, width, height } = el.getBoundingClientRect();
    expect(el.contains(document.elementFromPoint(left + width / 2, top + height / 2))).toBe(true);
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

  test('with repeat all on the last song, lists the songs that play again', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    player().cycleRepeat();
    player().next();
    await openPanel();

    await expect.element(panel().getByText('REPEATING')).toBeInTheDocument();
    await expect.element(panel().getByText('2 songs', { exact: false })).toBeInTheDocument();
    await expect
      .element(panel().getByText('Nothing queued', { exact: false }))
      .not.toBeInTheDocument();
    // Shown only: no play, reorder or remove controls on these rows.
    await expect.element(inPanel('Play Midnight Arcade')).not.toBeInTheDocument();

    await inPanel('Shuffle').click();
    await expect.element(panel().getByText('REPEATING, SHUFFLED')).toBeInTheDocument();
    await inPanel('Shuffle').click();

    await onBar('Repeat').click();
    await expect.element(panel().getByText('REPEATING')).not.toBeInTheDocument();
    await expect.element(panel().getByText('Nothing queued', { exact: false })).toBeInTheDocument();
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

describe('the Up next sheet on a phone', () => {
  const upNextSheet = () => page.getByRole('dialog', { name: 'Up next' });
  const inSheet = (name: string) => upNextSheet().getByRole('button', { name, exact: true });

  async function openSheet() {
    // The app's session wraps the player; the now-playing sheet reads it for the like.
    await renderWithProviders(
      <SignedOutSessionProvider>
        <MusicPlayerBar />
      </SignedOutSessionProvider>
    );
    await onBar('Open now playing').click();
    await page
      .getByRole('dialog', { name: 'Now playing' })
      .getByRole('button', { name: 'Up next', exact: true })
      .click();
    await expect.element(upNextSheet()).toBeVisible();
  }

  beforeEach(async () => {
    await page.viewport(390, 800);
  });

  test('opens over the now-playing sheet with the same sections as the desktop panel', async () => {
    player().playTrack(nowPlaying, {
      list: { name: 'Night Drive', tracks: [nowPlaying, palm, chrome] },
    });
    player().addToUpNext(rain);
    await openSheet();

    await expect.element(upNextSheet().getByText('QUEUED BY YOU')).toBeVisible();
    await expect.element(upNextSheet().getByText('NEXT FROM NIGHT DRIVE')).toBeVisible();
    const rows = upNextSheet()
      .getByRole('button', { name: /^Play / })
      .elements()
      .map((el) => el.textContent?.replace(/artist.*/, ''));
    expect(rows).toEqual(['Rain on Shibuya', 'Palm Static', 'Chrome Heart']);
    // On top of the now-playing sheet, once it has slid in.
    await expect
      .poll(() => {
        const { left, top, width, height } = upNextSheet().element().getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return upNextSheet().element().contains(hit);
      })
      .toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test('its rows play, remove and reorder through the player, with remove shown without hover', async () => {
    player().playTrack(nowPlaying, {
      list: { name: 'Post', tracks: [nowPlaying, palm, chrome, rain] },
    });
    await openSheet();

    const remove = inSheet('Remove Palm Static from up next');
    expect(getComputedStyle(remove.element()).opacity).toBe('1');
    await remove.click();
    expect(titles(player().list)).toEqual(['Chrome Heart', 'Rain on Shibuya']);

    (inSheet('Reorder Rain on Shibuya').element() as HTMLElement).focus();
    await userEvent.keyboard('{Space}');
    // The lifted row is placed against the window: inside the drawer, whose transform makes it the
    // containing block, it would sit rows off where the drop is measured.
    await vi.waitFor(() => {
      const lifted = [...document.querySelectorAll('[aria-label="Play Rain on Shibuya"]')].filter(
        (el) => !upNextSheet().element().contains(el)
      );
      expect(lifted).toHaveLength(1);
    });
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Space}');
    await vi.waitFor(() =>
      expect(titles(player().list)).toEqual(['Rain on Shibuya', 'Chrome Heart'])
    );

    await inSheet('Play Chrome Heart').click();
    expect(player().current?.title).toBe('Chrome Heart');
  });

  test('its header shuffles, repeats and clears through the player', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    player().addToUpNext(rain);
    await openSheet();

    await inSheet('Shuffle').click();
    expect(player().shuffle).toBe(true);
    await inSheet('Repeat').click();
    expect(player().repeat).toBe('all');
    await inSheet('Clear').click();
    expect(player().queued).toEqual([]);
    expect(player().list).toEqual([]);
    expect(player().playing).toBe(true);
  });

  test('lists the songs that repeat, shown only', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    player().cycleRepeat();
    player().next();
    await openSheet();

    await expect.element(upNextSheet().getByText('REPEATING')).toBeVisible();
    await expect.element(inSheet('Play Midnight Arcade')).not.toBeInTheDocument();
  });

  test('a long downward drag of its top closes it; a short one does not', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    await openSheet();
    const drag = (distance: number) => {
      const grab = upNextSheet().getByTestId('up-next-grab').element();
      const { left, top } = grab.getBoundingClientRect();
      for (const [type, y] of [
        ['pointerdown', top + 4],
        ['pointermove', top + 4 + distance / 2],
        ['pointermove', top + 4 + distance],
        ['pointerup', top + 4 + distance],
      ] as const)
        grab.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: left + 20, clientY: y })
        );
    };

    drag(30);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(upNextSheet()).toBeVisible();

    drag(160);
    await expect.element(upNextSheet()).not.toBeInTheDocument();
    await expect.element(page.getByRole('dialog', { name: 'Now playing' })).toBeVisible();
  });

  test('stays dark in light mode, over the always-dark now-playing sheet', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
    try {
      await openSheet();
      const rgb = (css: string) =>
        css
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      // Pencil `sQ6E2`: dark-5.
      expect(rgb(getComputedStyle(upNextSheet().element()).backgroundColor)).toEqual([44, 46, 51]);
      const title = upNextSheet().getByText('Palm Static').element();
      // Light text on it, not the light scheme's black.
      for (const channel of rgb(getComputedStyle(title).color))
        expect(channel).toBeGreaterThan(240);
    } finally {
      document.documentElement.removeAttribute('data-mantine-color-scheme');
    }
  });

  test('closes by Escape back to the now-playing sheet', async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await expect.element(upNextSheet()).not.toBeInTheDocument();
    await expect.element(page.getByRole('dialog', { name: 'Now playing' })).toBeVisible();
  });
});

// The song page's own Up next button (Pencil `bgZ7u`) opens the same queue as the player.
describe("the song page's Up next button", () => {
  const openFromSongPage = async () => {
    player().playTrack(nowPlaying, { list: { name: 'Post', tracks: [nowPlaying, palm] } });
    await renderWithProviders(<SongUpNextButton />);
    await page.getByRole('button', { name: 'Up next' }).click();
  };

  test('on a phone, opens the Up next sheet', async () => {
    await page.viewport(390, 844);
    await openFromSongPage();
    await expect.element(page.getByRole('dialog', { name: 'Up next' })).toBeVisible();
    await expect.element(panel()).not.toBeInTheDocument();
  });

  test('on a desktop, opens the Up next panel as before', async () => {
    await openFromSongPage();
    await expect.element(panel()).toBeVisible();
    await expect.element(page.getByRole('dialog', { name: 'Up next' })).not.toBeInTheDocument();
  });
});
