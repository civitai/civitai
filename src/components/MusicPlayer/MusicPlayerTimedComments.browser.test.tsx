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

import { SignedOutSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import {
  songDetails,
  timedComments,
} from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';
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
    user: { id: 100 + id, username, image: null, profilePicture: null as never },
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
// The name and the comment are separate parts of a label: read them as "name: comment".
const labels = () =>
  [...document.querySelectorAll('[data-testid="timed-comment-label"]')].map((l) =>
    [...l.lastElementChild!.children].map((part) => part.textContent).join(': ')
  );
const avatar = (id: number) =>
  document.querySelector(`[data-timed-comment="${id}"]`) as HTMLElement;
const cluster = (firstId: number) =>
  document.querySelector(`[data-timed-cluster="${firstId}"]`) as HTMLElement;
const label = () => document.querySelector('[data-testid="timed-comment-label"]') as HTMLElement;
const bar = () => document.querySelector('[data-music-player-bar]')!.getBoundingClientRect();
// Once: a click must not also reach a handler further up and open it twice.
const openedDetail = (commentId: number) => {
  expect(triggerRoutedDialog).toHaveBeenCalledTimes(1);
  expect(triggerRoutedDialog).toHaveBeenCalledWith({
    name: 'imageDetail',
    state: { imageId: SONG_ID, highlight: commentId },
  });
  expect(seekMusicPlayer).not.toHaveBeenCalled();
};
// Once, and without opening anything.
const seeked = (sec: number) => {
  expect(seekMusicPlayer).toHaveBeenCalledTimes(1);
  expect(seekMusicPlayer).toHaveBeenCalledWith(sec);
  expect(triggerRoutedDialog).not.toHaveBeenCalled();
};
const slider = () => document.querySelector('[role="slider"]')!.getBoundingClientRect();
const middle = (r: DOMRect) => r.top + r.height / 2;
const listOpen = () => document.querySelector('[role="dialog"][aria-label^="Comments around"]');
const at = (currentTime: number) =>
  act(() => useMusicPlayheadStore.setState({ currentTime, duration: DURATION }));

beforeEach(async () => {
  await page.viewport(1440, 800);
  // The pointer off the bar: one left over a stack by the test before would open its list.
  await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
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
    // Over the waveform's top edge, inside the bar.
    expect(middle(box)).toBeCloseTo(slider().top, 0);
    expect(box.top).toBeGreaterThanOrEqual(bar().top);
  });

  test('leave the waveform centred in the bar, where toggling them does not move it', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    const playTop = () =>
      page.getByRole('button', { name: 'Pause', exact: true }).element().getBoundingClientRect()
        .top;
    const before = { waveform: slider().top, play: playTop() };
    expect(Math.abs(middle(slider()) - middle(bar()))).toBeLessThanOrEqual(1);
    await userEvent.click(page.getByRole('button', { name: 'Hide timed comments', exact: true }));
    await expect.poll(strip).toBeNull();
    expect({ waveform: slider().top, play: playTop() }).toEqual(before);
    expect(Math.abs(middle(slider()) - middle(bar()))).toBeLessThanOrEqual(1);
  });

  test('show one label at a time, for 4 s from its time', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    expect(labels()).toEqual([]);
    await at(151);
    await expect.poll(labels).toEqual(['jo: the outro']);
    await at(154.5);
    await expect.poll(labels).toEqual([]);
  });

  test('a click on an avatar seeks there, without opening anything', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await userEvent.click(avatar(3));
    seeked(150);
  });

  test('Enter on an avatar seeks there', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    avatar(3).focus();
    await userEvent.keyboard('{Enter}');
    seeked(150);
  });

  test('focusing an avatar shows its comment; ArrowDown reaches it; Escape returns', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    avatar(3).focus();
    await expect.poll(labels).toEqual(['jo: the outro']);
    await userEvent.keyboard('{ArrowDown}');
    await expect.poll(() => document.activeElement).toBe(label());
    await userEvent.keyboard('{Escape}');
    await expect.poll(labels).toEqual([]);
    expect(document.activeElement).toBe(avatar(3));
  });

  test('the toggle hides them without moving the waveform; it shows them again', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    const waveformTop = () =>
      document.querySelector('[role="slider"]')!.getBoundingClientRect().top;
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
    expect(slider().height).toBe(48);
    expect(Math.abs(middle(slider()) - middle(bar()))).toBeLessThanOrEqual(1);
  });
});

describe('the floating label', () => {
  test('floats above the bar, at its avatar', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await at(151);
    await expect.poll(label).toBeTruthy();
    await expect.poll(() => label().getBoundingClientRect().bottom).toBeLessThanOrEqual(bar().top);
    // The label's own avatar sits over the strip's.
    const own = label().firstElementChild!.getBoundingClientRect();
    const anchor = avatar(3).getBoundingClientRect();
    expect(own.left + own.width / 2).toBeCloseTo(anchor.left + anchor.width / 2, 0);
  });

  test('shows the name and the comment apart, the comment dimmed', async () => {
    timedComments.served[SONG_ID] = [timed(3, 150, 'koenb', 'A really long comment')];
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await at(151);
    await expect.poll(label).toBeTruthy();
    const [name, text] = [...label().lastElementChild!.children] as HTMLElement[];
    expect(name.textContent).toBe('koenb');
    expect(text.textContent).toBe('A really long comment');
    expect(
      text.getBoundingClientRect().left - name.getBoundingClientRect().right
    ).toBeGreaterThanOrEqual(6);
    expect(getComputedStyle(text).color).toBe('rgb(140, 143, 163)');
  });

  test('stays inside the window at the end of the song', async () => {
    timedComments.served[SONG_ID] = [
      timed(9, 199, 'mira', 'a long last word on the song that runs past the edge of the window'),
    ];
    await renderBar();
    await expect.poll(() => avatar(9)).toBeTruthy();
    await at(199.5);
    await expect.poll(label).toBeTruthy();
    await expect.poll(() => label().getBoundingClientRect().bottom).toBeLessThanOrEqual(bar().top);
    expect(label().getBoundingClientRect().right).toBeLessThanOrEqual(
      document.documentElement.clientWidth
    );
  });

  test('a click opens the song with that comment highlighted', async () => {
    await renderBar();
    await expect.poll(() => avatar(3)).toBeTruthy();
    await at(151);
    await expect.poll(label).toBeTruthy();
    await userEvent.click(label());
    openedDetail(3);
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
    await expect
      .poll(() => list.element().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(bar().top);
    const row = list.getByRole('button', { name: /kai/ });
    await expect.element(row).toHaveTextContent('kai0:53who made the synth?');
    await userEvent.click(row);
    openedDetail(5);
  });

  test('a click on it seeks to its first comment, without opening anything', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    await userEvent.click(cluster(1));
    seeked(50);
  });

  test('Enter on it seeks to its first comment', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    cluster(1).focus();
    await userEvent.keyboard('{Enter}');
    seeked(50);
  });

  test('its list hides the floating label while it is open', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    await at(50.5);
    await expect.poll(labels).toEqual(['mira: that bass drop']);
    await userEvent.hover(cluster(1));
    await expect.poll(listOpen).toBeTruthy();
    expect(labels()).toEqual([]);
  });

  test('Escape closes its list and leaves focus on the stack', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    cluster(1).focus();
    await expect.poll(listOpen).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await expect.poll(listOpen).toBeNull();
    expect(document.activeElement).toBe(cluster(1));
  });

  test('Escape on the stack closes only its list, never reaching the page behind', async () => {
    const pageEscape = vi.fn();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && pageEscape();
    document.addEventListener('keydown', onKey);
    try {
      await renderBar();
      await expect.poll(() => cluster(1)).toBeTruthy();
      cluster(1).focus();
      await expect.poll(listOpen).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await expect.poll(listOpen).toBeNull();
      expect(pageEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('by keyboard, ArrowDown moves into its list, which stays open while focus is inside', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    cluster(1).focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect.poll(() => document.activeElement?.textContent).toBe('mira0:50that bass drop');
    await userEvent.keyboard('{ArrowDown}');
    await expect.poll(() => document.activeElement?.textContent).toBe('kat0:51here it comes');
    // Past the close delay, still open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listOpen()).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    openedDetail(2);
    await userEvent.keyboard('{Escape}');
    await expect.poll(listOpen).toBeNull();
    expect(document.activeElement).toBe(cluster(1));
  });

  test('its list closes when focus leaves', async () => {
    await renderBar();
    await expect.poll(() => cluster(1)).toBeTruthy();
    cluster(1).focus();
    await expect.poll(listOpen).toBeTruthy();
    cluster(1).blur();
    await expect.poll(listOpen).toBeNull();
  });

  for (const scheme of ['light', 'dark'])
    test(`its list's times read at WCAG AA in ${scheme} mode`, async () => {
      try {
        await renderBar();
        // After the render: the provider sets the scheme on mount.
        document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
        await expect.poll(() => cluster(1)).toBeTruthy();
        cluster(1).focus();
        await expect.poll(listOpen).toBeTruthy();
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
        const time = [...listOpen()!.querySelectorAll('span')].find(
          (el) => el.textContent === '0:50'
        )!;
        const [a, b] = [
          lum(rgb(getComputedStyle(time).color)),
          lum(rgb(getComputedStyle(listOpen()!).backgroundColor)),
        ];
        // The list is on the scheme's own surface: near white, or dark-5.
        if (scheme === 'dark') expect(b).toBeLessThan(0.05);
        else expect(b).toBeGreaterThan(0.95);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
      } finally {
        document.documentElement.removeAttribute('data-mantine-color-scheme');
      }
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
    await expect.poll(labels).toEqual(['mira: that bass drop']);
    await at(54.5);
    await expect.poll(labels).toEqual(['kat: here it comes']);
    await at(58.5);
    await expect.poll(labels).toEqual(['jun: on loop']);
  });
});

describe('timed comments on a phone', () => {
  const sheet = () => page.getByRole('dialog', { name: 'Now playing' });
  // The app's session wraps the player; the now-playing sheet reads it for the like.
  const renderPhone = () =>
    renderWithProviders(
      <SignedOutSessionProvider>
        <MusicPlayerBar />
      </SignedOutSessionProvider>
    );

  beforeEach(async () => {
    await page.viewport(390, 800);
    songDetails.reset();
  });

  test('show on the now-playing sheet’s waveform, the reached one’s label above it and on top', async () => {
    await renderPhone();
    await page.getByRole('button', { name: 'Open now playing' }).click();
    await expect.element(sheet()).toBeVisible();
    await expect.poll(() => cluster(1)).toBeTruthy();
    expect(sheet().element().contains(strip())).toBe(true);

    await at(50.5);
    await expect.poll(labels).toEqual(['mira: that bass drop']);
    const box = label().getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(strip()!.getBoundingClientRect().top);
    expect(box.top).toBeGreaterThanOrEqual(0);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(label().contains(hit)).toBe(true);
  });

  test('a label has its own row in the sheet: it never covers the lyric lines above', async () => {
    songDetails.lyrics = {
      [SONG_ID]: [
        { t: 40_000, text: 'Every high score I chase leads back to you' },
        { t: 50_000, text: 'Joystick heartbeat, pixel rain' },
        { t: 60_000, text: 'Player two, press start again' },
      ],
    };
    await renderPhone();
    await page.getByRole('button', { name: 'Open now playing' }).click();
    await expect.element(sheet()).toBeVisible();
    await expect.poll(() => cluster(1)).toBeTruthy();

    await at(50.5);
    await expect.poll(labels).toEqual(['mira: that bass drop']);
    const box = label().getBoundingClientRect();
    const lyrics = page.getByTestId('now-playing-lyrics').element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(lyrics.bottom);
    // One label at a time, nothing left behind it.
    expect(document.querySelectorAll('[data-testid="timed-comment-label"]')).toHaveLength(1);
  });
});
