/**
 * BlockImagePickerModal against the REAL cascade, at named viewports, with a LARGE library.
 *
 * What these measure is layout, so they live in the geometry tier: the `component` tier loads no
 * stylesheet, where the modal's flex column is inert and the grid's scroll box is as tall as its
 * content — the virtualizer then mounts every row and the confirm button sits wherever the list
 * ends, whatever the code does. Every test here first checks the cascade loaded.
 *
 * Regression coverage (red at origin/main, named per test) vs invariant guards (green there too)
 * is labelled on each test.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  box,
  cascadeEvidence,
  nextLayout,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as BrowsingLevelProviderModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as GenerationRequestHooks from '~/components/ImageGeneration/utils/generationRequestHooks';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as Trpc from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  postedQuery: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({ data: undefined, status: 'authenticated', update: async () => null }),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (orig) => ({
  ...(await orig<typeof BrowsingLevelProviderModule>()),
  useViewerBrowsingLevelDebounced: () => 3,
}));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose }),
}));

vi.mock('~/utils/trpc', async (orig) => ({
  ...(await orig<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'blockImagePicker.getPosted': {
      useInfiniteQuery: (...args: unknown[]) => mocks.postedQuery(...args),
    },
  }),
}));

vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', async (orig) => ({
  ...(await orig<typeof GenerationRequestHooks>()),
  useGetTextToImageRequests: () => ({
    data: [],
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => undefined,
  }),
}));

const { default: BlockImagePickerModal } = await import('./BlockImagePickerModal');

const CDN = 'https://image.civitai.com/acct';
const postedItem = (n: number) => ({
  imageId: 6000 + n,
  key: `key-${n}`,
  url: `${CDN}/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 1200,
  nsfwLevel: 1,
});

/** A library of `count` posted images, already loaded in pages of 40, with more on the server. */
function setLibrary(count: number) {
  const items = Array.from({ length: count }, (_, i) => postedItem(i + 1));
  const pages: Array<{ items: unknown[] }> = [];
  for (let i = 0; i < items.length; i += 40) pages.push({ items: items.slice(i, i + 40) });
  const fetchNextPage = vi.fn(async () => undefined);
  mocks.postedQuery.mockReturnValue({
    data: { pages },
    isLoading: false,
    isError: false,
    isFetching: false,
    hasNextPage: true,
    fetchNextPage,
    refetch: vi.fn(async () => undefined),
  });
  return fetchNextPage;
}

const postedTiles = () =>
  Array.from(document.querySelectorAll('button[aria-label^="Posted image "]'));
const tileNamed = (n: number) =>
  document.querySelector(`button[aria-label="Posted image ${n}"]`) as HTMLElement | null;

async function openPicker(vp: Viewport, max: number | null = 5) {
  const { observed } = await renderAtViewport(
    <BlockImagePickerModal sources={['posted', 'generated']} max={max} onResolved={vi.fn()} />,
    vp
  );
  expect(observed).toEqual({ width: vp.width, height: vp.height });
  expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(true);
  const dialog = await vi.waitUntil(() => document.querySelector<HTMLElement>('[role="dialog"]'));
  await vi.waitUntil(() => tileNamed(1));
  // Wait out the modal's open transition before measuring.
  await vi.waitUntil(() => document.getAnimations().length === 0, { timeout: 5000 });
  await nextLayout();
  return dialog;
}

const confirmButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith('Use ')
  ) as HTMLButtonElement;
const cancelButton = () =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Cancel'
  ) as HTMLButtonElement;
const scroller = () =>
  document.querySelector<HTMLElement>('[data-testid="block-image-picker-scroll"]');
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Use and Cancel lie inside the dialog's own box (not clipped by it) and inside the window. */
function expectFooterOnScreen(dialog: HTMLElement, vp: Viewport) {
  for (const button of [confirmButton(), cancelButton()]) {
    expect(box(button).height).toBeGreaterThan(0);
    expect(box(button).top).toBeGreaterThanOrEqual(Math.max(0, box(dialog).top));
    expect(box(button).bottom).toBeLessThanOrEqual(Math.min(vp.height, box(dialog).bottom));
  }
}

/** Mounted tiles may cover the visible rows plus the virtualizer's overscan (2) either side. */
function expectWindowedTileCount(grid: HTMLElement) {
  const tiles = postedTiles().map((t) => box(t));
  const columns = tiles.filter((t) => t.top === tiles[0].top).length;
  const rowHeight = tiles[0].height + 8;
  const visibleRows = Math.ceil(grid.clientHeight / rowHeight) + 1;
  expect(tiles.length).toBeGreaterThan(columns);
  expect(tiles.length).toBeLessThanOrEqual(columns * (visibleRows + 2 * 2));
}

const PHONES: Viewport[] = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];
const DESKTOPS: Viewport[] = [
  { width: 1280, height: 600 },
  { width: 1440, height: 900 },
];

describe('BlockImagePickerModal geometry with a large library', () => {
  // Regression: at origin/main the modal is at most 800px wide and its BODY scrolls, so on a
  // phone Cancel/Use sit below the fold under a 440px grid.
  test.each(PHONES)(
    'phone $width x $height: full screen, only the grid scrolls, Use and Cancel on screen',
    async (vp) => {
      setLibrary(200);
      const dialog = await openPicker(vp);

      expect(box(dialog)).toMatchObject({ width: vp.width, height: vp.height });
      expect(dialog.scrollHeight).toBe(dialog.clientHeight);
      expect(dialog.scrollWidth).toBe(dialog.clientWidth);
      const grid = scroller();
      if (!grid) throw new Error('grid scroller did not render');
      // The grid is under pressure: it, not the modal, holds the overflow.
      expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
      expectFooterOnScreen(dialog, vp);

      // Three tiles to a row at phone width.
      const [first, second, third, fourth] = postedTiles().map((t) => box(t));
      expect(first.top).toBe(second.top);
      expect(second.top).toBe(third.top);
      expect(fourth.top).toBeGreaterThan(first.top);
    }
  );

  // Invariant guard (red at origin/main only because there is no tray): picks add the tray above
  // the footer; the footer stays on screen and the grid keeps at least a row of height.
  test.each([PHONES[0], DESKTOPS[0]])(
    '$width x $height: with picks in the tray, Use and Cancel stay on screen',
    async (vp) => {
      setLibrary(200);
      const dialog = await openPicker(vp);
      tileNamed(1)?.click();
      tileNamed(2)?.click();
      const tray = await vi.waitUntil(() =>
        document.querySelector<HTMLElement>('[data-testid="block-image-picker-tray"]')
      );
      await nextLayout();

      expect(tray.querySelectorAll('[role="listitem"]')).toHaveLength(2);
      // The tray asks for the grid's own thumbnail url, so it is already loaded.
      const trayImg = tray.querySelector('img');
      const gridImg = tileNamed(1)?.querySelector('img');
      expect(trayImg?.getAttribute('src')).toBeTruthy();
      expect(trayImg?.getAttribute('src')).toBe(gridImg?.getAttribute('src'));
      expect(trayImg?.getAttribute('srcset')).toBe(gridImg?.getAttribute('srcset'));
      expectFooterOnScreen(dialog, vp);
      expect(dialog.scrollHeight).toBe(dialog.clientHeight);
      expect(dialog.scrollWidth).toBe(dialog.clientWidth);
      const grid = scroller();
      if (!grid) throw new Error('grid scroller did not render');
      expect(grid.clientHeight).toBeGreaterThanOrEqual(box(postedTiles()[0]).height);
    }
  );

  // A desktop picker is a centred modal, not full screen, with its footer on screen. Regression at
  // 1280 x 600 (at origin/main the 440px grid pushes Use below a short window); an invariant guard
  // at 1440 x 900, which fits either way.
  test.each(DESKTOPS)(
    'desktop $width x $height: a centred modal with Use on screen',
    async (vp) => {
      setLibrary(200);
      const dialog = await openPicker(vp);

      expect(box(dialog).width).toBeLessThanOrEqual(800);
      expect(box(dialog).height).toBeLessThan(vp.height);
      expect(Math.abs(box(dialog).left - (vp.width - box(dialog).right))).toBeLessThanOrEqual(1);
      expectFooterOnScreen(dialog, vp);
    }
  );

  // Regression: at origin/main every loaded tile is in the document (600 here).
  test.each([PHONES[1], DESKTOPS[1]])(
    '$width x $height: 600 loaded images mount only the tiles near view; scrolling to the end loads more',
    async (vp) => {
      const fetchNextPage = setLibrary(600);
      await openPicker(vp);
      const grid = scroller();
      if (!grid) throw new Error('grid scroller did not render');

      expectWindowedTileCount(grid);
      // Past the loader's start-up delay: nothing is fetched while the end of the list is far away.
      await settle(1700);
      expect(fetchNextPage).not.toHaveBeenCalled();

      grid.scrollTop = grid.scrollHeight;
      await vi.waitUntil(() => tileNamed(600), { timeout: 5000 });
      expect(tileNamed(1)).toBeNull();
      expectWindowedTileCount(grid);
      // The loader below the last row is now in view.
      await vi.waitFor(() => expect(fetchNextPage).toHaveBeenCalled(), { timeout: 6000 });
    }
  );

  // Regression: at origin/main every thumbnail asks for the 450 rendition. Measured at the
  // narrowest phone too, where a width taken from the ~88px tile would land on the 96 rung, which
  // has no 2x variant.
  test.each([{ width: 320, height: 640 }, PHONES[1], DESKTOPS[1]])(
    '$width x $height: a thumbnail is requested at the 320 rung, with a 512 2x variant',
    async (vp) => {
      setLibrary(200);
      await openPicker(vp);

      const tile = tileNamed(1);
      const img = tile?.querySelector('img');
      if (!tile || !img) throw new Error('first tile did not render');
      expect(box(tile).width).toBeGreaterThan(80);
      expect(box(tile).width).toBeLessThanOrEqual(250);
      expect(box(tile).height).toBe(box(tile).width);
      // Literal rungs of the image CDN's width ladder (`COMMON_IMAGE_WIDTHS`).
      expect(img.getAttribute('src')).toMatch(/\/width=320[,/]/);
      expect(img.getAttribute('srcset')).toMatch(/\/width=512[,/]/);
    }
  );
});
