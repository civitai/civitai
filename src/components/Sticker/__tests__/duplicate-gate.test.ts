import { describe, expect, it } from 'vitest';
import { unownedGateFor } from '~/components/Sticker/sticker.util';

/**
 * What a copy inherits, and — more importantly — what it does not.
 *
 * 🔴 THE REFILL GATE USED TO BE DECIDED HERE AND WRITTEN ONTO THE COPY. That is
 * a fact about the moment the copy was made rather than about the copy, and it
 * went stale the instant another draft was deleted: the use came back and the
 * copy carried on asking to be bought for it. Justin found that twice — the
 * first fix moved the decision for RENDERING but left this path still storing
 * one, so duplicates stayed frozen while dragged-out stickers no longer were.
 *
 * Whether an owned sticker has a use left now belongs to
 * `allocateDraftEntitlements`, recomputed across every draft on every render.
 * Nothing stores it. What is left here is the one gate that genuinely belongs to
 * a draft: this sticker is not owned yet and has to be bought.
 */
const pack = {
  pack: { shopItemId: 7, unitAmount: 500, acceptsBlue: false },
  creatorUsername: 'maker',
};

describe('the gate a copy inherits', () => {
  it('carries the not-owned-yet purchase, because one buy grants every copy', () => {
    expect(unownedGateFor({ purchase: pack })).toEqual(pack);
  });

  it('carries nothing for an owned sticker', () => {
    expect(unownedGateFor({})).toBeUndefined();
  });

  /**
   * The regression in one assertion. A refill gate must never travel with a
   * copy: the moment another draft is deleted, the use it was waiting for is
   * available and the allocation says so — but only if nothing has written the
   * old answer onto the draft.
   */
  it('refuses to carry a refill gate, which is what went stale', () => {
    const refill = { refill: true, perUse: 25, pack: { ...pack.pack, uses: 1 } };

    expect(unownedGateFor({ purchase: refill })).toBeUndefined();
  });

  it('carries nothing for a gate with no pack at all', () => {
    expect(unownedGateFor({ purchase: { refill: true, perUse: 25 } })).toBeUndefined();
  });
});

/**
 * 🔴 THE DEPENDENCY THE INHERITED GATE RESTS ON, PINNED.
 *
 * Giving a copy of an unbought sticker the SAME gate is only right because one
 * purchase grants the sticker and `markPurchased(cosmeticId)` then frees every
 * draft of it. Scope that per-draft later and this silently becomes "sell the
 * same sticker twice", with no test failing, because the gate itself would still
 * be correct.
 */
describe('one purchase frees every copy of the sticker', () => {
  it('lifts the gate from the original and its duplicate together', async () => {
    const { useStickerPlacementDraftStore } = await import('~/store/sticker-placement-draft.store');
    const store = () => useStickerPlacementDraftStore.getState();

    store().close();
    store().open(1);
    store().begin(42, { x: 0.4, y: 0.4 }, 0.4, pack);

    const originalId = store().drafts[0].id;
    store().duplicateDraft(originalId, unownedGateFor(store().drafts[0]));

    expect(store().drafts.map((draft) => draft.purchase)).toEqual([pack, pack]);

    store().markPurchased(42);

    expect(store().drafts.map((draft) => draft.purchase)).toEqual([undefined, undefined]);
  });
});
