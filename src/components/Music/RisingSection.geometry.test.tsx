import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type * as Trpc from '~/utils/trpc';

const server = vi.hoisted(() => ({ rising: [] as number[] }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: true }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('../MusicPlayer/__tests__/song-covers-trpc-stub');
  const stubbed = withSongCoversStub(actual.trpc);
  const getRisingSongs = { useQuery: () => ({ data: server.rising }) };
  const trpc = new Proxy(stubbed, {
    get: (target, key) =>
      key === 'image' ? { ...Reflect.get(target, key), getRisingSongs } : Reflect.get(target, key),
  });
  return { ...actual, trpc };
});
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useQueryImages: (filters: { ids?: number[] }) => ({
    images: (filters.ids ?? []).map((id) => song(id)),
    isLoading: false,
  }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#song" className={className}>
      {children}
    </a>
  ),
}));

import { RisingSection } from '~/components/Music/MusicLandingSections';
import { songCovers } from '~/components/MusicPlayer/__tests__/song-covers-trpc-stub';

function song(id: number) {
  return {
    id,
    url: `song-${id}.mp3`,
    type: 'audio',
    metadata: { title: `Song ${id}`, duration: 185 },
    user: { id: 100 + id, username: `artist${id}` },
    stats: {},
  } as unknown as ImagesInfiniteModel;
}

const allTiles = () =>
  [...document.querySelectorAll('a[href="#song"]')].map((link) => link.parentElement!);
// The tiles laid out at this width (past the fourth, a phone shows none).
const tiles = () => allTiles().filter((tile) => tile.getBoundingClientRect().width > 0);
const titleOf = (tile: Element) =>
  [...tile.querySelectorAll('span')].find((span) => span.textContent?.startsWith('Song '))!;
const box = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
};

/**
 * Every point of the grid lies in a tile or in a gap beside one: a missing tile leaves an area
 * farther than a gap from every tile.
 */
function expectNoEmptyCells(gap: number) {
  const cells = tiles();
  const grid = cells[0].parentElement!.getBoundingClientRect();
  const rects = cells.map((cell) => cell.getBoundingClientRect());
  for (const r of rects) {
    expect(r.left).toBeGreaterThanOrEqual(grid.left - 1);
    expect(r.right).toBeLessThanOrEqual(grid.right + 1);
  }
  const holes: string[] = [];
  for (let x = grid.left + 2; x < grid.right; x += 8)
    for (let y = grid.top + 2; y < grid.bottom; y += 8)
      if (
        !rects.some(
          (r) => x >= r.left - gap && x <= r.right + gap && y >= r.top - gap && y <= r.bottom + gap
        )
      )
        holes.push(`${Math.round(x - grid.left)},${Math.round(y - grid.top)}`);
  expect(holes).toEqual([]);
}

const DESKTOP = { width: 1440, height: 900 };
// The 390 page's content width, as Pencil `hiEzh` (16px padding each side).
const PhoneContent = () => (
  <div style={{ width: 358 }}>
    <RisingSection />
  </div>
);

describe.each([1, 2, 3, 4, 5, 7])('Rising this week with %i songs', (count) => {
  test('fills the mosaic at 1440 with no empty cell', async () => {
    server.rising = Array.from({ length: count }, (_, i) => i + 1);
    await renderAtViewport(<RisingSection />, DESKTOP);
    await vi.waitFor(() => expect(tiles()).toHaveLength(count));
    expectNoEmptyCells(20);
    // The large tile spans both 210px rows.
    expect(tiles()[0].getBoundingClientRect().height).toBe(440);
  });

  test('fills the grid at 390 with no empty cell', async () => {
    server.rising = Array.from({ length: count }, (_, i) => i + 1);
    await renderAtViewport(<PhoneContent />, PHONE_VIEWPORT);
    await vi.waitFor(() => expect(tiles()).toHaveLength(Math.min(count, 4)));
    expectNoEmptyCells(8);
    // Square large tile, as Pencil `P5rvz`'s 176px one; nothing overflows into a scrollbar.
    const large = box(tiles()[0]);
    expect(large.w).toBe(large.h);
    expect(large.w).toBeGreaterThanOrEqual(174);
    expect(large.w).toBeLessThanOrEqual(178);
    const grid = tiles()[0].parentElement!;
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
    expect(grid.scrollHeight).toBeLessThanOrEqual(grid.clientHeight);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
  });
});

test('at 390 with 4 or more songs the mosaic follows Pencil `P5rvz`: large, two square smalls, a wide one under them', async () => {
  server.rising = [1, 2, 3, 4, 5, 6, 7];
  await renderAtViewport(<PhoneContent />, PHONE_VIEWPORT);
  await vi.waitFor(() => expect(tiles()).toHaveLength(4));
  const [large, a, b, wide] = tiles().map((tile) => tile.getBoundingClientRect());
  for (const small of [a, b]) {
    expect(Math.round(small.width)).toBe(Math.round(small.height));
    expect(Math.round(small.height)).toBeGreaterThanOrEqual(83);
    expect(Math.round(small.height)).toBeLessThanOrEqual(85);
  }
  expect(Math.round(a.top)).toBe(Math.round(b.top));
  expect(Math.round(wide.left)).toBe(Math.round(a.left));
  expect(Math.round(wide.right)).toBe(Math.round(b.right));
  expect(Math.round(wide.bottom)).toBe(Math.round(large.bottom));
  // Small tiles are cover only; the large one keeps its title at 15px; small discs are 40px.
  const [largeTile, ...small] = tiles();
  for (const tile of small) {
    expect(titleOf(tile).getBoundingClientRect().height).toBe(0);
    expect(box(tile.querySelector('button')!)).toEqual({ w: 40, h: 40 });
  }
  expect(getComputedStyle(titleOf(largeTile)).fontSize).toBe('15px');
});

test('a lone tile at 1440 is no wider than the large tile', async () => {
  server.rising = [1];
  await renderAtViewport(<RisingSection />, DESKTOP);
  await vi.waitFor(() => expect(tiles()).toHaveLength(1));
  expect(box(tiles()[0])).toEqual({ w: 440, h: 440 });
});

test('with 7 songs at 1440 the small tiles follow Pencil `CnGl0`: wide/narrow/mid over narrow/wide/mid', async () => {
  server.rising = [1, 2, 3, 4, 5, 6, 7];
  await renderAtViewport(<RisingSection />, DESKTOP);
  await vi.waitFor(() => expect(tiles()).toHaveLength(7));
  const [, ...small] = tiles().map((tile) => Math.round(tile.getBoundingClientRect().width));
  const [wide, narrow, mid] = small;
  expect(small).toEqual([wide, narrow, mid, narrow, wide, mid]);
  expect(wide).toBeGreaterThan(mid);
  expect(mid).toBeGreaterThan(narrow);
});

test('a cover fills a wide small tile, past the width its image was requested at', async () => {
  server.rising = [1, 2, 3];
  songCovers.reset();
  songCovers.served = [1, 2, 3].map((songId) => ({
    songId,
    id: 1000 + songId,
    url: `cover-${songId}`,
    hash: null,
    nsfwLevel: 1,
  }));
  await renderAtViewport(<RisingSection />, DESKTOP);
  await vi.waitFor(() => expect(tiles()[1].querySelector('img')).not.toBeNull());
  const tile = tiles()[1].getBoundingClientRect();
  const img = tiles()[1].querySelector('img')!.getBoundingClientRect();
  expect(tile.width).toBeGreaterThan(760);
  expect(img.width).toBeCloseTo(tile.width, 0);
  songCovers.reset();
});
