import { beforeEach, describe, expect, it } from 'vitest';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * The gate that stops an unbought sticker being placed, and the one thing that
 * lifts it. Both are store state rather than component state because the
 * purchase button lives on the sticker while the thing that created it lives in
 * a panel across the screen.
 */
const purchase = {
  shopItemId: 7,
  unitAmount: 500,
  acceptsBlue: false,
  creatorUsername: 'maker',
};

const drafts = () => useStickerPlacementDraftStore.getState().drafts;

describe('draft purchase gate', () => {
  beforeEach(() => {
    useStickerPlacementDraftStore.getState().close();
    useStickerPlacementDraftStore.getState().open(1);
  });

  it('carries the purchase onto a draft dragged out of the shop', () => {
    useStickerPlacementDraftStore.getState().begin(42, { x: 0.5, y: 0.5 }, 0.4, purchase);
    expect(drafts()[0].purchase).toEqual(purchase);
  });

  it('leaves a draft of an owned sticker ungated', () => {
    useStickerPlacementDraftStore.getState().begin(42, { x: 0.5, y: 0.5 }, 0.4);
    expect(drafts()[0].purchase).toBeUndefined();
  });

  // One purchase grants the sticker, not one copy of it. Clearing only the
  // draft whose button was pressed would leave the second copy still asking to
  // be bought — selling the same sticker twice, which the server refuses, so
  // the buyer meets "You already own this cosmetic" instead of a Place button.
  it('lifts the gate from every draft of the sticker that was bought', () => {
    const store = useStickerPlacementDraftStore.getState();
    store.begin(42, { x: 0.3, y: 0.3 }, 0.4, purchase);
    store.begin(42, { x: 0.7, y: 0.7 }, 0.4, purchase);
    store.begin(99, { x: 0.5, y: 0.5 }, 0.4, { ...purchase, shopItemId: 8 });

    useStickerPlacementDraftStore.getState().markPurchased(42);

    const remaining = drafts();
    expect(remaining.filter((draft) => draft.cosmeticId === 42).map((d) => d.purchase)).toEqual([
      undefined,
      undefined,
    ]);
    // A different sticker is a different purchase and stays gated.
    expect(remaining.find((draft) => draft.cosmeticId === 99)?.purchase).toBeDefined();
  });

  it('keeps every other property of the draft it ungates', () => {
    useStickerPlacementDraftStore.getState().begin(42, { x: 0.25, y: 0.75 }, 0.4, purchase);
    const before = drafts()[0];
    useStickerPlacementDraftStore.getState().markPurchased(42);
    expect(drafts()[0]).toEqual({ ...before, purchase: undefined });
  });
});
