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

const tiles = () =>
  [...document.querySelectorAll('a[href="#song"]')].map((link) => link.parentElement!);

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

describe.each([1, 3, 7])('Rising this week with %i songs', (count) => {
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
    await renderAtViewport(<RisingSection />, PHONE_VIEWPORT);
    await vi.waitFor(() => expect(tiles()).toHaveLength(count));
    expectNoEmptyCells(8);
  });
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
