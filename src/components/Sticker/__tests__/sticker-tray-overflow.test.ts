// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';

/**
 * The sticker row must scroll through ONE plain overflow container.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE BROWSER SUITE CANNOT GATE ANYTHING. The sibling
 * `StickerPlacementTray.overflow.browser.test.tsx` asserts the same shape with a real
 * DOM, but `*.browser.test.tsx` runs in no CI job, and it also loads no stylesheet — a
 * probe there reported the sticker row as 400px wide while a real browser had it at
 * 954. So neither file can measure layout, and only this one runs on a PR.
 *
 * What broke: the row scrolled through `ScrollArea.Autosize`, which wraps its child in
 * a `display:flex; overflow:auto` box whose `flex:1` inner box keeps `min-width: auto`.
 * Against a `wrap="nowrap"` row that inner box will not shrink to the panel, so it
 * became a second scroll container and Mantine's viewport measured 555px inside a 474px
 * panel — 81px of scroll track, and the last sticker, outside the clip. The same wrapper
 * left the bar absent on first open (`type="auto"` only shows it once its ResizeObserver
 * produces a measurement, which on first mount it does not).
 *
 * Both numbers came from a dev server and are recorded in the fix's commit message.
 * Here, only the structure is checkable — and the structure is what regressed.
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
  url: `https://example.test/${i}.png`,
  animated: false,
}));

vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: owned, isLoading: false }),
  useStickerRefill: () => () => ({ refill: true }),
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

import { MantineProvider } from '@mantine/core';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

const renderTray = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(StickerPlacementTray, { imageId: IMAGE_ID })
      )
    );
  });
  return container;
};

describe('sticker placement tray overflow', () => {
  it('renders every sticker owned — the row is never truncated to fit', async () => {
    const container = await renderTray();
    expect(container.querySelectorAll('img[alt^=":"]')).toHaveLength(owned.length);
  });

  it('scrolls the row through exactly one plain overflow container', async () => {
    const container = await renderTray();
    const sticker = container.querySelector('img[alt^=":"]');
    const scroller = sticker?.closest('.overflow-x-auto');
    expect(
      scroller,
      'the sticker row has no `overflow-x-auto` ancestor — whatever owns the overflow now ' +
        'needs its panel width and its first-open behaviour re-measured in a real browser'
    ).not.toBeNull();

    // The defect was a second scroll container BETWEEN the row and the panel clipping it.
    const panel = scroller?.closest('.overflow-hidden');
    expect(panel).not.toBeNull();
    let between = scroller?.parentElement ?? null;
    while (between && between !== panel) {
      expect(
        between.className,
        `a container between the sticker row and the panel carries its own overflow ` +
          `(${between.className}) — that is the two-scroll-container defect returning`
      ).not.toMatch(/overflow-(x|y)?-?(auto|scroll)/);
      between = between.parentElement;
    }
  });

  it('wraps the row in no Mantine ScrollArea', async () => {
    const container = await renderTray();
    expect(
      container.querySelector('[class*="mantine-ScrollArea"]'),
      'a Mantine ScrollArea is back around the sticker row. `ScrollArea.Autosize` is what ' +
        'produced the 81px-too-wide viewport and the bar absent on first open'
    ).toBeNull();
  });
});
