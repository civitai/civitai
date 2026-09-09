import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

/**
 * The "Made by you" filter, and — the half more likely to rot — the THRESHOLD
 * that keeps it from costing anything for the 97.6% of owners who hold 12 or
 * fewer stickers.
 *
 * 🔴 THE GATE IS THE POINT, NOT AN OPTIMISATION. This filter was chosen over
 * widening `user.getCosmetics` precisely because it costs one extra request for
 * the ~49 owners who can see the control at all. Delete the `enabled` clause and
 * the feature still works perfectly in every manual test while every owner on
 * the site pays a round trip on tray-open. Nothing else in the suite would say
 * so, which is why the second test here asserts the request did NOT go out.
 */
const IMAGE_ID = 1;
const VIEWER_ID = 7;

const owned = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Sticker ${i + 1}`,
    slug: `sticker-${i + 1}`,
    url: `sticker-${i + 1}.png`,
    animated: false,
    pricePerUse: 0,
    obtainedAt: new Date('2026-01-01T00:00:00.000Z'),
  }));

const state = {
  owned: owned(13),
  /** Which of the owned ids the viewer is the creator of. */
  mine: [2, 5] as number[],
};

/** Every `getStickerAttribution` call, so the gate can be asserted on directly. */
const attributionCalls: { ids: number[]; enabled: boolean }[] = [];

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useImagePlacementSpace: () => ({
    space: { mode: 'open', price: 0, ownerId: 999, freeSlots: 0, freeSlotsRemaining: 0 },
    isLoading: false,
  }),
  useFreePlacementStanding: () => ({ standing: null, isLoading: false }),
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

// Spread rather than hand-listed: a hand-written factory replaces the module, so
// the day `sticker.util` gains an export this file omits, the import fails and
// the WHOLE FILE collects zero tests — silently green.
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: state.owned, bySlug: new Map(), isLoading: false }),
}));

vi.mock('~/components/Sticker/StickerShopPanel', () => ({ StickerShopPanel: () => null }));
vi.mock('~/components/Sticker/StickerShopTile', () => ({ StickerShopTile: () => null }));
vi.mock('~/components/Sticker/use-sticker-drag-out', () => ({
  useStickerDragOut: () => ({ grab: () => undefined, dragging: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: VIEWER_ID }) }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    cosmetic: {
      getStickerBalances: { useQuery: () => ({ data: [] }) },
      getStickerRecentUse: { useQuery: () => ({ data: [] }) },
      getStickerOffers: { useQuery: () => ({ data: [] }) },
      getStickerAttribution: {
        useQuery: (input: { ids: number[] }, options: { enabled?: boolean } = {}) => {
          const enabled = options.enabled !== false;
          attributionCalls.push({ ids: input.ids, enabled });
          // React Query hands back no data for a disabled query. Returning rows
          // anyway would let a broken gate still render a working chip, which is
          // the exact regression this file is here to catch.
          if (!enabled) return { data: undefined };
          return {
            data: input.ids.map((id) => ({
              id,
              name: `Sticker ${id}`,
              creatorId: state.mine.includes(id) ? VIEWER_ID : 999,
              creatorName: null,
              shopHref: null,
            })),
          };
        },
      },
    },
  },
}));

const renderTray = async () => {
  renderWithProviders(
    <IsClientProvider>
      <StickerPlacementTray imageId={IMAGE_ID} />
    </IsClientProvider>
  );
  await expect.element(page.getByText(/Drag a sticker onto the image/)).toBeInTheDocument();
};

const tiles = () => Array.from(document.querySelectorAll('img[alt^=":sticker-"]'));

beforeEach(() => {
  attributionCalls.length = 0;
  state.owned = owned(13);
  state.mine = [2, 5];
});

describe('StickerPlacementTray — Made by you', () => {
  test('narrows the tray to the stickers the viewer created', async () => {
    await renderTray();
    expect(tiles()).toHaveLength(13);

    await page.getByText('Made by you').click();

    // Named by slug rather than counted, so a revert fails saying WHICH stickers
    // came back rather than "expected 13 to be 2".
    await expect
      .poll(() => tiles().map((img) => img.getAttribute('alt')))
      .toEqual([':sticker-2:', ':sticker-5:']);
  });

  test('does not draw the chip for someone who made none of them', async () => {
    state.mine = [];
    await renderTray();

    // Wait for the CONTROLS, not for the tray: the chip renders beside them, so
    // asserting its absence before they exist would pass while the collection
    // was still loading.
    await expect.element(page.getByPlaceholder('Search')).toBeInTheDocument();
    expect(page.getByText('Made by you').elements()).toHaveLength(0);
  });

  test('🔴 asks for attribution only above the search threshold', async () => {
    // 12 is the threshold itself; the controls render above it, not at it.
    state.owned = owned(12);
    await renderTray();

    // The query hook still RUNS — it is a hook, it cannot be conditional — so the
    // assertion is on the gate it was handed, not on the call count.
    expect(attributionCalls.length).toBeGreaterThan(0);
    const enabledCalls = attributionCalls.filter((call) => call.enabled);
    expect(
      enabledCalls.length ? `enabled with ${enabledCalls[0].ids.length} ids` : 'never enabled'
    ).toBe('never enabled');
  });

  test('and does ask above it, so the check above can fail', async () => {
    state.owned = owned(13);
    await renderTray();

    // The positive control for the gate test: same assertion shape, opposite
    // expectation. Without this, a gate wired permanently OFF would pass there.
    const enabledCalls = attributionCalls.filter((call) => call.enabled);
    expect(
      enabledCalls.length ? `enabled with ${enabledCalls[0].ids.length} ids` : 'never enabled'
    ).toBe('enabled with 13 ids');
  });
});
