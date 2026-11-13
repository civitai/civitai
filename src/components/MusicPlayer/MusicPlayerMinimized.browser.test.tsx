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
  const { withSongCoversStub } = await import('./__tests__/song-covers-trpc-stub');
  return { ...actual, trpc: withSongCoversStub(actual.trpc) };
});
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: false, pauseTour: vi.fn(), activeTour: null }),
}));

import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { MusicPlayerMinimized } from '~/components/MusicPlayer/MusicPlayerMinimized';
import { useMusicPlayerStore } from '~/store/music-player.store';

const song: MusicTrack = {
  id: 1,
  url: 'song-key',
  title: 'Midnight Arcade',
  durationSec: 212,
  creator: { id: 2, username: 'neonwave' },
};

const player = () => useMusicPlayerStore.getState();
const button = (name: string) => page.getByRole('button', { name, exact: true });
const minimized = () => document.querySelector('[data-music-player-minimized]') as HTMLElement;
const bar = () => document.querySelector('[data-music-player-bar]');
// The hover controls fade in and out; `toBeVisible` ignores opacity, so read it once settled.
const controlsShown = (shown: boolean) =>
  vi.waitFor(() =>
    expect(getComputedStyle(button('Pause').element().parentElement as Element).opacity).toBe(
      shown ? '1' : '0'
    )
  );

function pointer(type: string, target: Element, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: type === 'pointerup' ? 0 : 1,
    })
  );
}

// The two surfaces as the mount renders them, without the audio element (no file loads here).
function Player() {
  return (
    <>
      <MusicPlayerBar />
      <MusicPlayerMinimized />
    </>
  );
}

beforeEach(async () => {
  await page.viewport(1440, 800);
  player().close();
  player().playTrack(song);
});

describe('the minimized player', () => {
  test('minimize swaps the bar for the cover, and expand brings the bar back', async () => {
    await renderWithProviders(<Player />);
    await button('Minimize player').click();
    await expect.element(button('Expand player')).toBeInTheDocument();
    expect(bar()).toBeNull();
    expect(player().playing).toBe(true);

    await button('Expand player').click();
    await expect.element(button('Minimize player')).toBeInTheDocument();
    expect(minimized()).toBeNull();
  });

  test('sits bottom-left by default and closes the player from its close button', async () => {
    player().minimize();
    await renderWithProviders(<Player />);
    await expect.element(button('Expand player')).toBeInTheDocument();
    const rect = minimized().getBoundingClientRect();
    expect(rect.left).toBe(16);
    expect(rect.width).toBe(80);

    await button('Close player').click();
    expect(player().current).toBeNull();
    expect(minimized()).toBeNull();
  });

  test('shows its controls on hover and on keyboard focus only', async () => {
    player().minimize();
    await renderWithProviders(
      <>
        <button type="button">Before</button>
        <Player />
      </>
    );
    await controlsShown(false);

    await userEvent.hover(minimized());
    await controlsShown(true);
    await userEvent.unhover(minimized());
    await controlsShown(false);

    (button('Before').element() as HTMLElement).focus();
    await userEvent.tab();
    await expect.element(button('Expand player')).toHaveFocus();
    await controlsShown(true);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(player().playing).toBe(false);
  });

  test('a drag moves the cover and keeps the spot, without pressing the button under it', async () => {
    player().minimize();
    await renderWithProviders(<Player />);
    await expect.element(button('Pause')).toBeInTheDocument();
    const center = button('Pause').element();
    const start = center.getBoundingClientRect();
    const [x, y] = [start.left + 30, start.top + 30];

    pointer('pointerdown', center, x, y);
    pointer('pointermove', center, x + 200, y - 300);
    pointer('pointerup', center, x + 200, y - 300);
    center.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(player().playing).toBe(true);
    const position = player().minimizedPosition;
    expect(position).not.toBeNull();
    await vi.waitFor(() => {
      const moved = minimized().getBoundingClientRect();
      expect(Math.round(moved.left)).toBe(Math.round(start.left - 6 + 200));
    });

    // A plain press after the drag still works.
    center.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(player().playing).toBe(false);
  });

  test('stays inside the window when it shrinks', async () => {
    player().minimize();
    player().setMinimizedPosition({ x: 0.95, y: 0.02 });
    await renderWithProviders(<Player />);
    await expect.element(button('Expand player')).toBeInTheDocument();
    await page.viewport(390, 700);
    await vi.waitFor(() =>
      expect(minimized().getBoundingClientRect().right).toBeLessThanOrEqual(390)
    );
  });
});
