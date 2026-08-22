import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as CfImages from '~/client-utils/cf-images-utils';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

/**
 * The tray's stickers wrap into rows, and the rows scroll VERTICALLY through one
 * plain overflow container capped at two rows.
 *
 * 🔴 STRUCTURE, NOT LAYOUT, AND THAT IS FORCED. Neither vitest project loads a
 * stylesheet — not Mantine's, not Tailwind's — so every width measured in a test
 * here is a lie: a probe on the broken build reported the row as 400px wide while
 * a real browser had it at 954. Every number below came from a dev server on the
 * production database and lives in the commit messages.
 *
 * What broke: the row was one `wrap="nowrap"` line inside `ScrollArea.Autosize`.
 * Autosize wraps its child in a `display:flex; overflow:auto` box whose `flex:1`
 * inner box keeps `min-width: auto`, so the inner box refuses to shrink to the
 * panel and becomes a SECOND scroll container measuring a width nothing shows —
 * 3463px of viewport inside a 1254px panel for an account owning 83 stickers. The
 * same wrapper left the scrollbar absent on first open, because `type="auto"`
 * reveals it only once its ResizeObserver produces a measurement.
 *
 * So the shape is the thing to guard: stickers wrap, exactly one `overflow-y-auto`
 * ancestor, nothing else scrolling between it and the panel, and no Mantine
 * ScrollArea anywhere in the tray.
 */
const IMAGE_ID = 1;

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useImagePlacementSpace: () => ({
    space: { mode: 'open', price: 100, ownerId: 999, freeSlots: 0, freeSlotsRemaining: 0 },
    isLoading: false,
  }),
  useFreePlacementStanding: () => ({ standing: undefined, isLoading: false }),
}));

vi.mock('~/store/sticker-placement-draft.store', () => ({
  useStickerPlacementDraftStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      targetImageId: IMAGE_ID,
      trayOpen: true,
      drafts: [],
      closeTray: () => undefined,
      setTray: () => undefined,
      begin: () => undefined,
    }),
}));

// The collection size the three reports share — an alphabet set is 26 on its own.
const owned = Array.from({ length: 26 }, (_, i) => ({
  id: i + 1,
  slug: `letter-${i}`,
  url: LOADABLE_IMAGE_DATA_URI,
  animated: false,
}));

vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: owned, isLoading: false }),
  useStickerRefill: () => () => ({ refill: true }),
}));

// The edge CDN rewrites any non-http src, which would turn the loadable data URI
// into a URL this scaffold cannot serve.
vi.mock('~/client-utils/cf-images-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CfImages>()),
  useEdgeUrl: (src: string) => ({ url: src, type: 'image' as const }),
}));

vi.mock('~/components/Sticker/StickerShopPanel', () => ({ StickerShopPanel: () => null }));
vi.mock('~/components/Sticker/StickerShopTile', () => ({ StickerShopTile: () => null }));
vi.mock('~/components/Sticker/use-sticker-drag-out', () => ({
  useStickerDragOut: () => ({ grab: () => undefined, dragging: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    cosmetic: {
      getStickerBalances: { useQuery: () => ({ data: [] }) },
      getStickerOffers: { useQuery: () => ({ data: [] }) },
    },
  },
}));

const renderTray = async () => {
  renderWithProviders(
    <IsClientProvider>
      <StickerPlacementTray imageId={IMAGE_ID} />
    </IsClientProvider>
  );
  await expect.element(page.getByText('Drag a sticker onto the image.')).toBeInTheDocument();
};

describe('sticker placement tray overflow', () => {
  test('every sticker owned is rendered — the row is never truncated to fit', async () => {
    await renderTray();
    expect(document.querySelectorAll('img[alt^=":"]')).toHaveLength(owned.length);
  });

  test('the row scrolls through exactly one plain vertical overflow container', async () => {
    await renderTray();

    const sticker = document.querySelector('img[alt^=":"]');
    const scroller = sticker?.closest('.overflow-y-auto');
    expect(
      scroller,
      'the sticker row has no `overflow-y-auto` ancestor — whatever replaced it owns the ' +
        'overflow now, and the panel-width and first-open behaviour need re-measuring in a ' +
        'real browser (see the file header)'
    ).not.toBeNull();

    // Between the scroller and the panel that clips it there must be nothing else
    // scrolling: the defect was a second container between those two.
    const panel = scroller?.closest('.overflow-hidden');
    expect(panel).not.toBeNull();
    let between = scroller?.parentElement ?? null;
    while (between && between !== panel) {
      expect(
        between.className,
        `a container between the sticker row and the panel now carries its own overflow ` +
          `(${between.className}) — that is the two-scroll-container defect returning`
      ).not.toMatch(/overflow-(x|y)?-?(auto|scroll)/);
      between = between.parentElement;
    }
  });

  test('no Mantine ScrollArea wraps the sticker row', async () => {
    await renderTray();

    const sticker = document.querySelector('img[alt^=":"]');
    const tray = sticker?.closest('.fixed');
    expect(
      tray?.querySelector('[class*="mantine-ScrollArea"]'),
      'a Mantine ScrollArea is back around the sticker row. `ScrollArea.Autosize` is what ' +
        'produced the 81px-too-wide viewport and the bar that never appeared on first open'
    ).toBeNull();
  });

  test('the sticker row wraps rather than running off in one line', async () => {
    await renderTray();

    const row = document.querySelector('img[alt^=":"]')?.closest('button')?.parentElement;
    expect(
      (row as HTMLElement | null)?.style.getPropertyValue('--group-wrap'),
      'the row is back to `wrap="nowrap"`, which is the one-long-line layout the tray was ' +
        'moved off — 83 stickers then run 6452px wide instead of wrapping into rows'
    ).not.toBe('nowrap');
  });
});
