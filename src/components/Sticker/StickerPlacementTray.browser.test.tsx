import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

/**
 * The tray's pre-commit reason: why free is unavailable, said while both options
 * are still on screen.
 *
 * 🔴 This file exists because the reason was rendered by nothing under test. The
 * branches of `preCommitFreeReason` are covered exhaustively as a pure function
 * in `__tests__/free-offer.test.ts`, and the reaction-bar suite mocks this whole
 * component away — so deleting the block that renders the sentence left every
 * suite in the repo green while half of what the change is for silently stopped
 * reaching a screen.
 *
 * Scoped to that one line. The tray's drag-out gesture, shop panel and purchase
 * path are somebody else's tests.
 */
const IMAGE_ID = 1;

const queryState = {
  /** The creator's side: capacity, and how much of it is currently held. */
  freeSlots: 1,
  freeSlotsRemaining: 1,
  /** The viewer's side. `usedHere` is the rule only this surface can see. */
  remaining: 1,
  usedHere: false,
};

// Spread the real module rather than hand-listing it, so this test does not
// couple itself to the tray's whole transitive import graph.
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useImagePlacementSpace: () => ({
    space: {
      mode: 'open',
      price: 100,
      ownerId: 999,
      freeSlots: queryState.freeSlots,
      freeSlotsRemaining: queryState.freeSlotsRemaining,
    },
    isLoading: false,
  }),
  useFreePlacementStanding: () => ({
    standing: {
      used: 1 - queryState.remaining,
      remaining: queryState.remaining,
      usedHere: queryState.usedHere,
      resetsAt: new Date('2026-08-21T00:00:00.000Z'),
    },
    isLoading: false,
  }),
}));

// The tray only renders for the image whose session is open, so the store is
// driven rather than mocked away — `showing` is what gates everything below it.
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

// Owning nothing is the tray's simplest state and says nothing about the free
// offer, which is the only thing this file asserts.
// Spread rather than hand-listed, which is not tidiness: a hand-written factory
// replaces the module, so the day `sticker.util` gains an export this file omits,
// the import fails and the WHOLE FILE collects zero tests — silently green. It
// happened twice while the duplicate action was being built, once for
// `useStickerRefill` and once for `remainingStickerUses`. Only the two hooks
// that would reach the network are overridden.
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  // Owning nothing is the tray's simplest state and says nothing about the free
  // offer, which is the only thing this file asserts.
  useOwnedSticker: () => ({ sticker: [], isLoading: false }),
  // Owning nothing, nothing here is ever spent — but the hook runs a query, so
  // it is stubbed rather than left to reach a client this scaffold does not
  // provide.
  useStickerRefill: () => () => ({ refill: true }),
}));
vi.mock('~/components/Sticker/StickerShopPanel', () => ({ StickerShopPanel: () => null }));
vi.mock('~/components/Sticker/StickerShopTile', () => ({ StickerShopTile: () => null }));
vi.mock('~/components/Sticker/use-sticker-drag-out', () => ({
  useStickerDragOut: () => ({ grab: () => undefined, dragging: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

// The tray calls two cosmetic queries directly. The scaffold is network-free and
// provides no tRPC client, so an unmocked `trpc.*` render throws and this file
// would assert against an empty body — which is why the harness note says tRPC
// hooks are mocked per test.
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
  renderWithProviders(<StickerPlacementTray imageId={IMAGE_ID} />);
  await expect.element(page.getByText(/Drag a sticker onto the image/)).toBeInTheDocument();
};

describe('StickerPlacementTray — the reason free is unavailable', () => {
  test('says the allowance is spent, and what it is shared with, before anything is placed', async () => {
    Object.assign(queryState, {
      freeSlots: 1,
      freeSlotsRemaining: 1,
      remaining: 0,
      usedHere: false,
    });
    await renderTray();

    await expect.element(page.getByText(/used today's free placement/)).toBeInTheDocument();
    // The second ticket: this reader may well have spent it on a remix gallery,
    // and without this clause the sticker surface cannot account for where it
    // went.
    await expect
      .element(page.getByText(/shared between stickers and remix galleries/))
      .toBeInTheDocument();
  });

  test('says a free sticker was already used on this image', async () => {
    // The rule the reaction bar cannot see — a per-image fact — which is why the
    // tray is the surface that has to say it.
    Object.assign(queryState, {
      freeSlots: 1,
      freeSlotsRemaining: 1,
      remaining: 1,
      usedHere: true,
    });
    await renderTray();

    await expect
      .element(page.getByText(/already used a free sticker on this image/))
      .toBeInTheDocument();
  });

  test('does not tell someone who has pressed nothing that they lost a race', async () => {
    Object.assign(queryState, {
      freeSlots: 1,
      freeSlotsRemaining: 0,
      remaining: 1,
      usedHere: false,
    });
    await renderTray();

    await expect.element(page.getByText(/free slot on this image is taken/)).toBeInTheDocument();
    // "Someone took the last free slot FIRST" is the post-refusal wording and is
    // false about a reader who has not pressed anything.
    expect(page.getByText(/first/i).elements()).toHaveLength(0);
  });

  /**
   * 🔴 Silence, which is the state most of the site is in.
   *
   * Free is genuinely on offer here, so a sentence explaining why it is not
   * would be both wrong and alarming. Asserted with a positive control in the
   * same render — the price line — so this cannot pass because the tray failed
   * to render at all.
   */
  test('says nothing about a refusal when free is on offer', async () => {
    Object.assign(queryState, {
      freeSlots: 1,
      freeSlotsRemaining: 1,
      remaining: 1,
      usedHere: false,
    });
    await renderTray();

    await expect.element(page.getByText(/Free, or 100 Buzz/)).toBeInTheDocument();
    expect(page.getByText(/used today's free placement/).elements()).toHaveLength(0);
    expect(page.getByText(/already used a free sticker/).elements()).toHaveLength(0);
    expect(page.getByText(/free slot on this image is taken/).elements()).toHaveLength(0);
  });

  test('says nothing on an image whose creator never offered free', async () => {
    Object.assign(queryState, {
      freeSlots: 0,
      freeSlotsRemaining: 0,
      remaining: 0,
      usedHere: false,
    });
    await renderTray();

    // The price line still renders — the tray is fine, it simply has no refusal
    // to explain, because nobody was offered anything.
    await expect.element(page.getByText(/100 Buzz \+ one use/)).toBeInTheDocument();
    expect(page.getByText(/used today's free placement/).elements()).toHaveLength(0);
  });
});
