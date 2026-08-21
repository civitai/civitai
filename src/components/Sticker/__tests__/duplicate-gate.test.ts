import { describe, expect, it, vi } from 'vitest';
import { duplicateGateFor, remainingStickerUses } from '~/components/Sticker/sticker.util';

/**
 * Whether a duplicated sticker has to be bought — the money decision, and the
 * part that was wrong.
 *
 * It lived as a closure inside `DraftStickerLayer`, where nothing could test it,
 * and three independent reviews found the same defect in it: a sticker dragged
 * from the shop has NO balance row, which the old code read as "not spent" and
 * therefore "no gate" — producing a Place button on a sticker nobody had bought,
 * which the server refuses at `assertHasUse` after taking an escrow hold.
 *
 * Every branch below is one of those cases, asserted directly rather than
 * through a component that cannot reach them.
 */
const pack = {
  pack: { shopItemId: 7, unitAmount: 500, acceptsBlue: false },
  creatorUsername: 'maker',
};

const refill = { refill: true, perUse: 25, creatorUsername: 'maker' };
const refillFor = () => refill;

const owned = (remaining: number | null) => [{ cosmeticId: 42, remaining }];
const source = (purchase?: typeof pack) => ({ cosmeticId: 42, purchase });

describe('the gate on a duplicated draft', () => {
  it('keeps the source gate for a sticker the viewer does not own', () => {
    // The shop-dragged case: balances loaded, no row for this cosmetic. One
    // purchase grants the sticker and frees every draft of it, so the copy must
    // carry the same gate rather than none.
    expect(duplicateGateFor({ source: source(pack), drafts: [], balances: [], refillFor })).toEqual(
      pack
    );
  });

  it('keeps the source gate while the balances are still loading', () => {
    // Indistinguishable from "not owned" at this layer, and the honest answer is
    // the same one. Guessing "has uses" is what shipped a Place button that
    // could not be placed.
    expect(
      duplicateGateFor({ source: source(pack), drafts: [], balances: undefined, refillFor })
    ).toEqual(pack);
  });

  it('gates nothing when the sticker is unlimited', () => {
    expect(
      duplicateGateFor({ source: source(), drafts: [], balances: owned(null), refillFor })
    ).toBeUndefined();
  });

  it('gates nothing while a use remains after every draft', () => {
    const drafts = [{ cosmeticId: 42 }];

    expect(
      duplicateGateFor({ source: source(), drafts, balances: owned(2), refillFor })
    ).toBeUndefined();
  });

  /**
   * The arithmetic that decides who pays. Every draft of the sticker already on
   * the image spends a use when it is bought — including the one being copied —
   * so a single use with one draft against it is already committed.
   */
  it('offers a top-up when the drafts already on the image spend the last use', () => {
    const drafts = [{ cosmeticId: 42 }];

    expect(duplicateGateFor({ source: source(), drafts, balances: owned(1), refillFor })).toEqual(
      refill
    );
  });

  it('offers a top-up when the sticker is outright spent', () => {
    expect(
      duplicateGateFor({ source: source(), drafts: [], balances: owned(0), refillFor })
    ).toEqual(refill);
  });

  it('passes the owned price through, so a copy is never stuck on “sells no uses”', () => {
    const spy = vi.fn(() => refill);

    duplicateGateFor({
      source: source(),
      drafts: [],
      balances: owned(0),
      refillFor: spy,
      ownedPricePerUse: 25,
    });

    expect(spy).toHaveBeenCalledWith(42, 25);
  });

  it('ignores drafts of other stickers', () => {
    const drafts = [{ cosmeticId: 99 }, { cosmeticId: 99 }];

    expect(
      duplicateGateFor({ source: source(), drafts, balances: owned(1), refillFor })
    ).toBeUndefined();
  });
});

/**
 * The three states, kept apart. Collapsing "not loaded" into either of the other
 * two is the bug above in its general form.
 */
describe('remaining uses', () => {
  it('is undefined before the balances arrive', () => {
    expect(
      remainingStickerUses({ balances: undefined, drafts: [], cosmeticId: 42 })
    ).toBeUndefined();
  });

  it('is undefined for a sticker with no holding, which is not the same as zero', () => {
    expect(remainingStickerUses({ balances: [], drafts: [], cosmeticId: 42 })).toBeUndefined();
  });

  it('is null for an unlimited holding', () => {
    expect(remainingStickerUses({ balances: owned(null), drafts: [], cosmeticId: 42 })).toBeNull();
  });

  it('subtracts every draft of that sticker', () => {
    const drafts = [{ cosmeticId: 42 }, { cosmeticId: 42 }, { cosmeticId: 99 }];

    expect(remainingStickerUses({ balances: owned(5), drafts, cosmeticId: 42 })).toBe(3);
  });

  it('floors at zero rather than going negative', () => {
    const drafts = [{ cosmeticId: 42 }, { cosmeticId: 42 }, { cosmeticId: 42 }];

    expect(remainingStickerUses({ balances: owned(1), drafts, cosmeticId: 42 })).toBe(0);
  });
});
